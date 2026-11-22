/**
 * 抓包会话管理。
 *
 * 一条会话 = 一个我们**自己新建**的标签页 + 一个连到该标签页的 CDP WebSocket。
 * "单会话"是产品约束而不是技术限制：同一台 NAS 只有一块出口网卡，并行抓两个站点
 * 会让慢域名的归属变得无法判断（同一个 CDN 域名两边都在用），而且 noVNC 里
 * 只看得见一个画面，用户会以为页面串了。
 *
 * 三个容易踩的坑，这个文件专门处理：
 *
 * 1) 清理时误伤用户标签页
 *    只关 /json/new 返回的那个 targetId，永远不调 /json/close 的批量形式，
 *    也不复用用户已经打开的标签页。CDP 的 WS 是绑在单个 target 上的，
 *    所以我们收到的事件天然只属于自己那一页。start 中途失败时同样只关自己开的。
 *
 * 2) CDP 断线
 *    浏览器容器重启、连接空闲被回收都会断。断线后按 200ms / 600ms / 1.5s 退避
 *    重连同一 targetId（标签页还在的话 URL 就不变）；标签页没了就直接判 failed，
 *    因为此时页面状态已经丢了，继续"抓"只会给出一份空报告。
 *
 * 3) 会话泄漏
 *    用户点了开始就关掉浏览器页签是常态。除了 /stop，还有两条兜底：
 *    超过 CAPTURE_MAX_MS 自动停；60s 未完成的请求由 tracker.sweep 结账。
 */

import { randomBytes } from 'node:crypto'
import type { CaptureSession, CapturedRequest, HostSummary } from './types.ts'
import {
  CdpClient,
  RequestTracker,
  closeTarget,
  createTarget,
  getCdpVersion,
  listTargets,
} from './cdp.ts'
import { CaptureStreamHub, type CaptureFrame } from './stream.ts'
import { listStoredSessions, loadSession, saveSession, type StoredSession } from './store.ts'
import { inferPageHost, normalizeHost } from './aggregate.ts'
import { markSniBlocked, summarize } from './advice.ts'
import { comparePreview } from './preview-compare.ts'
import { writeInjected, clearInjected, readInjected } from './preview-hosts.ts'
import { listBlocked } from '../blocked.ts'

/** 默认最长采集时长：3 分钟。再长基本是用户忘了关，占着浏览器窗口没意义 */
const DEFAULT_MAX_MS = 180_000
/** 在途请求的巡检间隔 */
const SWEEP_INTERVAL_MS = 5_000
/** 断线重连的退避序列；长度即最大尝试次数 */
const RECONNECT_DELAYS = [200, 600, 1500]
/** 开启 Network 域的超时：冷启动浏览器可能要好几秒 */
const ATTACH_ENABLE_TIMEOUT_MS = 10_000

function envPositive(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 带 HTTP 状态码的业务错误，路由层直接映射成契约里的错误码 */
export class CaptureHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CaptureHttpError'
    this.status = status
  }
}

/**
 * 校验并补全起始地址。
 *
 * 允许用户只输 `github.com`：控制台里粘贴域名比粘贴完整 URL 更常见，
 * 而浏览器不补协议会当成相对路径（navigate 到 about:blank 的同级）。
 */
export function normalizeStartUrl(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new CaptureHttpError(400, 'url 不能为空')
  if (raw.length > 2048) throw new CaptureHttpError(400, 'url 过长')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new CaptureHttpError(400, 'url 不是合法地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CaptureHttpError(400, '只支持 http/https 地址')
  }
  return parsed.toString()
}

function newSessionId(): string {
  // 时间戳在前便于按文件名排序，随机后缀防同毫秒冲突
  return `capture-${Date.now()}-${randomBytes(3).toString('hex')}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

interface LiveSession {
  session: CaptureSession
  storeUrls: boolean
  baseUrl: string
  /** 我们自己 /json/new 出来的标签页；停止时只关它 */
  targetId: string
  client: CdpClient | null
  tracker: RequestTracker
  hosts: Set<string>
  reconnectAttempts: number
  /** stop 已开始：忽略后续 CDP 事件与断线回调 */
  closing: boolean
  /** 资源已释放，dispose 幂等 */
  disposed: boolean
  sweepTimer: ReturnType<typeof setInterval> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  /**
   * 预览模式（v1.2）：用 CDP 的 Network.setHostMapping 在浏览器内临时改写解析，
   * 只影响这个标签页，不动系统 hosts。
   *
   * 有了它就能「先试后写」：把候选 IP 映射进去重载页面，
   * 用真实抓包数字验证效果，确认无误再落成 rules。
   */
  preview: PreviewState | null
}

/** 一次预览：映射了哪些域名、从哪条记录开始算"预览后" */
export interface PreviewState {
  /** 域名 → IP，仅浏览器内生效 */
  mappings: Record<string, string>
  /**
   * entries 分界索引：小于它的是"预览前"（基线），大于等于的是"预览后"。
   *
   * 为什么不用时间戳切分：CapturedRequest 没有起始时间字段，
   * 而 CDP 的 monotonic 时间戳与墙钟不在一个时基上，换算容易出错。
   * 索引是严格追加的，天然可靠。
   */
  fromIndex: number
  appliedAt: number
}

export class CaptureManager {
  private readonly live = new Map<string, LiveSession>()
  private readonly hub = new CaptureStreamHub()
  /**
   * start 的异步窗口互斥。检查 live 里有没有 running 与真正建立会话之间隔着
   * 好几个 await（HTTP + WS 握手），没有这个 flag 的话两个并发 start 会同时通过检查。
   */
  private starting = false
  private readonly getCdpUrl: () => string

  constructor(getCdpUrl: () => string) {
    this.getCdpUrl = getCdpUrl
  }

  get streams(): CaptureStreamHub {
    return this.hub
  }

  /** 是否有会话正在采集（starting / running） */
  get runningId(): string | null {
    if (this.starting) return '*'
    for (const rec of this.live.values()) {
      if (rec.session.status === 'starting' || rec.session.status === 'running') {
        return rec.session.id
      }
    }
    return null
  }

  async start(input: { url?: unknown; storeUrls?: unknown }): Promise<CaptureSession> {
    const url = normalizeStartUrl(input?.url)
    const storeUrls = input?.storeUrls === true

    if (this.starting || this.runningId) throw new CaptureHttpError(409, '已有抓包会话在运行')

    this.starting = true
    const baseUrl = this.getCdpUrl()
    let rec: LiveSession | null = null
    try {
      // 先确认 CDP 可达再开标签页：否则浏览器没起来时会留下一堆 about:blank
      await getCdpVersion(baseUrl)
      const target = await createTarget(baseUrl, 'about:blank')

      rec = this.createRecord({
        id: newSessionId(),
        url,
        storeUrls,
        baseUrl,
        targetId: target.id,
      })
      this.live.set(rec.session.id, rec)

      await this.attach(rec, target.webSocketDebuggerUrl!)
      await this.navigate(rec, url)
      return this.snapshot(rec)
    } catch (err) {
      if (rec) {
        // 只清掉自己开的那一个标签页；状态已经是 failed 的会话要留档给前端看
        const persist = rec.session.status === 'failed'
        await this.dispose(rec, { persist })
      }
      throw toHttpError(err)
    } finally {
      this.starting = false
    }
  }

  async stop(id: string): Promise<CaptureSession> {
    const rec = this.live.get(id)
    if (!rec) {
      // 已经停过（内存里没有了）：返回磁盘上的那份，让接口幂等
      const stored = await loadSession(id)
      if (!stored) throw new CaptureHttpError(404, 'session not found')
      return stored.session
    }
    if (rec.closing) return this.snapshot(rec)

    // 先把在途请求结账，再发 end——顺序反了前端会收到"结束后又冒出新请求"
    rec.tracker.flush()
    rec.closing = true
    this.clearTimers(rec)

    if (rec.session.status !== 'failed') rec.session.status = 'stopped'
    if (!rec.session.endedAt) rec.session.endedAt = new Date().toISOString()

    const session = this.snapshot(rec)
    this.publish(rec, { type: 'state', session })
    this.publish(rec, { type: 'end', sessionId: rec.session.id })

    await this.dispose(rec, { persist: true })
    return session
  }

  /** 内存优先，回落到磁盘；都找不到返回 null（路由层转 404） */
  async detail(id: string): Promise<StoredSession | null> {
    const rec = this.live.get(id)
    if (rec) return { session: this.snapshot(rec), requests: [...rec.tracker.entries] }
    return loadSession(id)
  }

  /**
   * 会话列表：内存（正在跑的，计数最新）覆盖磁盘（历史）。
   * 按 startedAt 倒序，与契约 §2 的 `/?limit=20` 一致。
   */
  async list(limit = 20): Promise<CaptureSession[]> {
    const capped = Math.max(1, Math.min(Math.floor(limit) || 20, 100))
    const merged = new Map<string, CaptureSession>()
    for (const s of await listStoredSessions(100)) merged.set(s.id, s)
    for (const rec of this.live.values()) merged.set(rec.session.id, this.snapshot(rec))
    return [...merged.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, capped)
  }

  /**
   * 聚合 + 建议。
   *
   * SNI 阻断按域名标记，但**只查已知清单**（data/blocked-domains.json），
   * 不对每个 host 现场 probe：一次典型抓包有 30~80 个域名，每个 probe 是
   * DNS+TCP+TLS 好几秒，串下来 /summary 要几十秒，前端只能转圈。
   * 现场探测留给用户勾选后的 /apply——那时通常是 1~10 个域名，且用户愿意等。
   */
  async summary(id: string): Promise<HostSummary[] | null> {
    const rec = this.live.get(id)
    let requests: CapturedRequest[]
    let startUrl: string
    if (rec) {
      requests = [...rec.tracker.entries]
      startUrl = rec.session.url
    } else {
      const stored = await loadSession(id)
      if (!stored) return null
      requests = stored.requests
      startUrl = stored.session.url
    }

    const pageHost = hostOfUrl(startUrl) || inferPageHost(requests)
    const summaries = summarize(requests, { pageHost })

    let blocked: string[] = []
    try {
      blocked = (await listBlocked()).map((entry) => entry.domain)
    } catch {
      // 清单读不到就按"没有已知阻断"处理，不影响其它判定
    }
    return markSniBlocked(summaries, blocked)
  }

  /**
   * 应用一组域名映射（预览），只影响抓包浏览器。
   *
   * 走共享文件而不是 CDP：Network.setHostMapping 不是标准 CDP 命令
   * （实测报 wasn't found）。chromium 容器把 /etc/hosts 绑到 data/preview-hosts，
   * app 写同一个文件即可，且实测 Chrome 会实时读取、无需重启。
   */
  async applyPreview(id: string, mappings: Record<string, string>): Promise<PreviewState> {
    const rec = this.live.get(id)
    if (!rec) throw new CaptureHttpError(409, '会话未在运行，无法预览')
    if (!rec.client) throw new CaptureHttpError(409, 'CDP 连接已断开')
    if (rec.closing || rec.disposed) throw new CaptureHttpError(409, '会话正在结束')

    const clean: Record<string, string> = {}
    for (const [rawHost, rawIp] of Object.entries(mappings)) {
      const host = String(rawHost || '').trim().toLowerCase()
      const ip = String(rawIp || '').trim()
      if (!host || !ip) continue
      if (!/^[a-z0-9.-]+$/.test(host)) continue
      if (!/^[0-9a-fA-F:.]+$/.test(ip)) continue
      clean[host] = ip
    }
    if (!Object.keys(clean).length) {
      throw new CaptureHttpError(400, '没有合法的域名到 IP 映射')
    }

    // 分界点必须在重载之前取：重载会立刻产生新请求
    const fromIndex = rec.tracker.entries.length
    await writeInjected(clean)
    rec.preview = { mappings: clean, fromIndex, appliedAt: Date.now() }
    // 重载页面让映射立即生效（虽实测会实时读取，但重载能拿到干净的对比数据）
    await this.navigate(rec, rec.session.url)
    return rec.preview
  }

  /** 撤销预览：清掉注入的映射并重载回原始状态 */
  async clearPreview(id: string): Promise<boolean> {
    const rec = this.live.get(id)
    await clearInjected()
    if (!rec?.client) return false
    rec.preview = null
    await this.navigate(rec, rec.session.url)
    return true
  }

  /** 当前预览状态；没有则为 null */
  getPreview(id: string): PreviewState | null {
    return this.live.get(id)?.preview ?? null
  }

  /**
   * 预览对比：把"预览前"和"预览后"的同一批域名并排比。
   *
   * 用 tracker.entries 的索引切分，而不是时间戳——CapturedRequest
   * 没有起始时间字段，索引严格追加更可靠。
   */
  async previewCompare(id: string): Promise<{
    preview: PreviewState
    rows: import('./preview-compare.ts').CompareRow[]
  } | null> {
    const rec = this.live.get(id)
    if (!rec?.preview) return null

    const all = rec.tracker.entries
    const before = all.slice(0, rec.preview.fromIndex)
    const after = all.slice(rec.preview.fromIndex)

    const startUrl = rec.session.url
    const pageHost = hostOfUrl(startUrl) || inferPageHost(all)

    const toTiming = (reqs: CapturedRequest[]) =>
      summarize(reqs, { pageHost }).map((h) => ({
        host: h.host,
        requests: h.requests,
        p95TotalMs: h.p95TotalMs,
        failures: h.failures,
      }))

    return {
      preview: rec.preview,
      rows: comparePreview(
        toTiming(before),
        toTiming(after),
        Object.keys(rec.preview.mappings),
      ),
    }
  }

  /** 进程退出时用：不留悬空标签页 */
  async shutdown(): Promise<void> {
    for (const rec of [...this.live.values()]) {
      await this.dispose(rec, { persist: rec.tracker.entries.length > 0 })
    }
  }

  // ------------------------------------------------------------ 内部

  private createRecord(args: {
    id: string
    url: string
    storeUrls: boolean
    baseUrl: string
    targetId: string
  }): LiveSession {
    const session: CaptureSession = {
      id: args.id,
      url: args.url,
      status: 'starting',
      startedAt: new Date().toISOString(),
      requestCount: 0,
      hostCount: 0,
    }
    const hosts = new Set<string>()
    // 先声明 rec，回调在 rec 赋值后才会被调用（事件是异步来的）
    let rec: LiveSession
    const tracker = new RequestTracker({
      storeUrls: args.storeUrls,
      onRequest: (req) => {
        rec.session.requestCount = rec.tracker.entries.length
        hosts.add(req.host)
        rec.session.hostCount = hosts.size
        this.publish(rec, { type: 'request', request: req })
      },
    })
    rec = {
      session,
      storeUrls: args.storeUrls,
      baseUrl: args.baseUrl,
      targetId: args.targetId,
      client: null,
      tracker,
      hosts,
      reconnectAttempts: 0,
      closing: false,
      disposed: false,
      sweepTimer: null,
      maxTimer: null,
      preview: null,
    }
    return rec
  }

  /**
   * 建立 WS 并开启 Network 域。
   *
   * 冷启动的 Chromium（容器刚起来、profile 首次初始化）响应 Network.enable 可能要好几秒，
   * 所以这两条命令单独放宽超时；普通命令仍按 3s 计，避免一次抖动拖住整个接口。
   */
  private async attach(rec: LiveSession, wsUrl: string, enableTimeoutMs = ATTACH_ENABLE_TIMEOUT_MS): Promise<void> {
    const client = new CdpClient(wsUrl, {
      onEvent: (method, params) => {
        if (rec.closing) return
        rec.tracker.handle(method, params)
      },
      onClose: (reason) => {
        void this.onDisconnect(rec, reason)
      },
    })
    await client.connect()
    rec.client = client

    // 关缓存：抓包的目的是看"真实网络代价"，命中的缓存请求不产生耗时，
    // 留着只会让用户以为某个域名很快。
    await client.send(
      'Network.enable',
      {
        maxTotalBufferSize: 32 * 1024 * 1024,
        maxResourceBufferSize: 8 * 1024 * 1024,
        maxPostDataSize: 0,
      },
      enableTimeoutMs,
    )
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, enableTimeoutMs)
  }

  private async navigate(rec: LiveSession, url: string): Promise<void> {
    const result = await rec.client!.send<{ errorText?: string }>('Page.navigate', { url }, 5000)
    // start 期间被 /stop 抢先了：不要再把状态改回 running
    if (rec.closing || rec.disposed) return
    if (result?.errorText) {
      // 导航失败不是 HTTP 层错误：标签页开出来了、CDP 也通，是目标站点的问题。
      // 契约要求这种情况给前端一帧 error，所以这里返回 200 + status=failed。
      this.fail(rec, `页面导航失败：${result.errorText}`)
      return
    }
    rec.session.status = 'running'
    this.publish(rec, { type: 'state', session: this.snapshot(rec) })
    this.startTimers(rec)
  }

  private startTimers(rec: LiveSession): void {
    rec.maxTimer = setTimeout(() => {
      void this.stop(rec.session.id).catch(() => {
        /* 自动停止失败不影响用户手动停 */
      })
    }, envPositive('CAPTURE_MAX_MS', DEFAULT_MAX_MS))
    rec.maxTimer.unref?.()

    rec.sweepTimer = setInterval(() => {
      if (rec.closing) return
      rec.tracker.sweep()
    }, SWEEP_INTERVAL_MS)
    rec.sweepTimer.unref?.()
  }

  private clearTimers(rec: LiveSession): void {
    if (rec.maxTimer) clearTimeout(rec.maxTimer)
    if (rec.sweepTimer) clearInterval(rec.sweepTimer)
    rec.maxTimer = null
    rec.sweepTimer = null
  }

  /**
   * 非主动断开。注意 rec.client 已经被底层置空，这里只负责重连或结案。
   * 递归重试受 RECONNECT_DELAYS 长度限制，成功后计数归零，下次断开重新给满次数。
   */
  private async onDisconnect(rec: LiveSession, reason: string): Promise<void> {
    if (rec.closing || rec.disposed) return
    if (rec.session.status !== 'running') return
    rec.client = null

    if (rec.reconnectAttempts >= RECONNECT_DELAYS.length) {
      this.fail(rec, `CDP 连接断开（重连失败：${reason}）`)
      return
    }
    const delay = RECONNECT_DELAYS[rec.reconnectAttempts]
    rec.reconnectAttempts += 1
    await sleep(delay)
    if (rec.closing || rec.disposed || rec.session.status !== 'running') return

    try {
      // 只找自己那个 targetId：用户可能在这期间关了标签页，也可能开了别的新标签页
      const targets = await listTargets(rec.baseUrl)
      const target = targets.find((t) => t.id === rec.targetId && t.webSocketDebuggerUrl)
      if (!target) {
        this.fail(rec, 'CDP 标签页已被关闭，抓包中断')
        return
      }
      // 换代：新的 WS 会让 requestId 从 1 重新开始，不换代会把新请求当成重复
      rec.tracker.beginEpoch()
      await this.attach(rec, target.webSocketDebuggerUrl!)
      rec.reconnectAttempts = 0
    } catch {
      void this.onDisconnect(rec, reason)
    }
  }

  private fail(rec: LiveSession, message: string): void {
    if (rec.closing) return
    rec.session.status = 'failed'
    rec.session.error = message
    if (!rec.session.endedAt) rec.session.endedAt = new Date().toISOString()
    this.publish(rec, { type: 'error', message })
    this.publish(rec, { type: 'state', session: this.snapshot(rec) })
    this.publish(rec, { type: 'end', sessionId: rec.session.id })
    void this.dispose(rec, { persist: true })
  }

  private async dispose(rec: LiveSession, opts: { persist: boolean }): Promise<void> {
    if (rec.disposed) return
    rec.disposed = true
    rec.closing = true
    this.clearTimers(rec)
    try {
      rec.tracker.flush()
    } catch {
      /* 结账失败不影响清理 */
    }

    rec.client?.close()
    rec.client = null
    // 只关我们自己开的标签页；targetId 为空说明都没开成功，跳过
    if (rec.targetId) await closeTarget(rec.baseUrl, rec.targetId)
    this.live.delete(rec.session.id)

    if (opts.persist) {
      try {
        await saveSession({ session: this.snapshot(rec), requests: [...rec.tracker.entries] })
      } catch (err) {
        // 落盘失败只影响历史记录，不能让 stop 接口报错——数据还在内存里，
        // 用户可以立刻调 /summary 拿到结论
        console.error('[capture] 会话落盘失败', err instanceof Error ? err.message : err)
      }
    }
  }

  private snapshot(rec: LiveSession): CaptureSession {
    return {
      ...rec.session,
      requestCount: rec.tracker.entries.length,
      hostCount: rec.hosts.size,
    }
  }

  private publish(rec: LiveSession, frame: CaptureFrame): void {
    this.hub.publish(rec.session.id, frame)
  }
}

function hostOfUrl(raw: string): string {
  try {
    return normalizeHost(new URL(raw).host)
  } catch {
    return ''
  }
}

/** 底层异常 → 契约里的 HTTP 语义。CDP 不可达统一 502，参数问题 400 */
function toHttpError(err: unknown): Error {
  if (err instanceof CaptureHttpError) return err
  // 契约要求 502 的 body 就是这一句；底层细节（fetch failed / ECONNREFUSED）
  // 对用户没有指导意义，留在日志里给运维看
  console.error('[capture] CDP 交互失败', err instanceof Error ? err.message : err)
  return new CaptureHttpError(502, 'Chromium 未就绪（CDP 连接失败）')
}
