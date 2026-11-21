/**
 * 极简 CDP 客户端 + 事件映射。
 *
 * 为什么不用 puppeteer：整个项目只有两个运行时依赖（hono / @hono/node-server），
 * 而这里需要的能力只有四件事——打一次 HTTP 拿 target 列表、开一个标签页、
 * 在标签页上跑 JSON-RPC、把 Network 事件记下来。为此引一个 300MB 的浏览器
 * 驱动既拖慢构建，也会让 NAS 上的镜像体积翻倍。Node 22 自带全局 WebSocket，
 * 所以自己写这 200 行更划算。
 *
 * 文件分三层：
 *   1. 纯函数（kindFromResourceType / ttfbFromTiming / elapsedMs ...）—— 可单测，零 IO
 *   2. RequestTracker —— 消费 Network.* 事件产出 CapturedRequest，仍然零 IO
 *   3. CdpClient + HTTP helpers —— 唯一会碰网络的部分
 *
 * 事件按 tab 隔离：WebSocket 是直接连到单个 target 的，不会收到同一浏览器里
 * 其它标签页的事件，这点对"不误伤用户标签页"很关键（见 session.ts）。
 */

import type { CapturedRequest, RequestKind } from './types.ts'
import { normalizeHost } from './aggregate.ts'

// 单次 CDP 命令的默认超时。CDP 在本机 loopback 上正常 < 20ms，
// 3s 已足够宽松；再长只会让 start 失败时前端白等。
const DEFAULT_COMMAND_TIMEOUT_MS = 3000

// HTTP 侧（/json/*）的默认超时，比命令超时略短：连不上要尽快给用户 502。
const DEFAULT_HTTP_TIMEOUT_MS = 2500

// ---------------------------------------------------------------- 纯函数

/**
 * CDP 的 ResourceType → 契约里的 RequestKind。
 *
 * 刻意把 Stylesheet / Manifest / Prefetch / WebSocket 等一律归到 'other'：
 * 契约只留了 7 个类型，前端表格按这 7 个分组，多出来的类型会让筛选器出现空组。
 */
export function kindFromResourceType(type?: string): RequestKind {
  switch ((type ?? '').toLowerCase()) {
    case 'document':
      return 'document'
    case 'script':
      return 'script'
    case 'xhr':
    case 'fetch':
      return 'xhr'
    case 'image':
      return 'img'
    case 'font':
      return 'font'
    case 'media':
    case 'texttrack':
      return 'media'
    default:
      return 'other'
  }
}

/**
 * 从 URL 里取 host（小写、去端口）。
 *
 * 解析失败返回空串，调用方据此丢弃该请求：没有 host 的请求（data:、blob:、
 * chrome-extension:）既不能改 hosts 也不能屏蔽，留在明细里只会污染统计。
 */
export function hostFromUrl(raw: string): string {
  if (!raw) return ''
  try {
    return normalizeHost(new URL(raw).host)
  } catch {
    return ''
  }
}

/**
 * TTFB（首字节耗时）。
 *
 * 契约口径是"请求发起到收到响应头"。CDP 的 timing 各字段都是相对 requestTime
 * 的毫秒偏移，所以 TTFB = receiveHeadersEnd - sendStart（sendStart 为 -1 表示
 * 复用了长连接、没有独立的发送阶段，此时退化成 receiveHeadersEnd）。
 *
 * 不用 receiveHeadersStart：它只覆盖"等服务端响应"这一段，会把 DNS/TCP/TLS
 * 的时间丢掉，导致慢在握手上的域名反而显示得很快——那正是我们要抓的场景。
 */
export function ttfbFromTiming(timing?: CdpResponseTiming): number | undefined {
  if (!timing) return undefined
  const end = timing.receiveHeadersEnd
  if (typeof end !== 'number' || end < 0) return undefined
  const start =
    typeof timing.sendStart === 'number' && timing.sendStart >= 0 ? timing.sendStart : 0
  return roundMs(end - start)
}

/** 把浮点毫秒收敛成整数，负数与离谱值当作"测不到" */
export function roundMs(ms: number | undefined): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  // 超过 10 分钟的单条请求基本是浏览器把连接挂死了，记下来也没有参考价值
  if (ms > 600_000) return undefined
  return Math.round(ms)
}

/** 两个 CDP 单调时间戳（秒）之间的毫秒差 */
export function elapsedMs(startTs: number, endTs: number): number | undefined {
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return undefined
  return roundMs((endTs - startTs) * 1000)
}

/**
 * 缓存命中判定。
 *
 * fromDiskCache / fromMemoryCache 是契约口径。Service Worker 单独处理不了：
 * 它既可能是缓存转发、也可能是现场生成的响应，标成 cached 会把真实的慢请求藏起来，
 * 所以这里不看 fromServiceWorker；预加载/内存缓存的情况由
 * Network.requestServedFromCache 事件补上（见 RequestTracker.handle）。
 */
export function isCachedResponse(response?: CdpResponse): boolean {
  if (!response) return false
  return response.fromDiskCache === true || response.fromMemoryCache === true
}

// ---------------------------------------------------------------- CDP payload 形状

/** 只声明用得到的字段，其余忽略；CDP 的字段随版本增减，不能当契约用 */
export interface CdpResponseTiming {
  requestTime?: number
  dnsStart?: number
  dnsEnd?: number
  connectStart?: number
  connectEnd?: number
  sendStart?: number
  sendEnd?: number
  receiveHeadersStart?: number
  receiveHeadersEnd?: number
}

export interface CdpResponse {
  url?: string
  status?: number
  mimeType?: string
  fromDiskCache?: boolean
  fromMemoryCache?: boolean
  fromServiceWorker?: boolean
  encodedDataLength?: number
  timing?: CdpResponseTiming
}

export interface CdpRequestWillBeSent {
  requestId: string
  timestamp: number
  type?: string
  frameId?: string
  loaderId?: string
  documentURL?: string
  request?: { url?: string; method?: string }
  /** 存在即为重定向：本条事件的 request 是重定向后的新请求 */
  redirectResponse?: CdpResponse
}

export interface CdpResponseReceived {
  requestId: string
  timestamp: number
  type?: string
  response: CdpResponse
}

export interface CdpLoadingFinished {
  requestId: string
  timestamp: number
  encodedDataLength?: number
}

export interface CdpLoadingFailed {
  requestId: string
  timestamp: number
  errorText?: string
  canceled?: boolean
  type?: string
}

// ---------------------------------------------------------------- RequestTracker

interface Inflight {
  /** 事件里的原始 requestId，重连换代后可能与旧请求重名，所以 key 另加 epoch 前缀 */
  key: string
  requestId: string
  host: string
  url?: string
  kind: RequestKind
  frameId?: string
  /** CDP 的单调时间戳（秒）：只用于算 totalMs，不能和 Date.now() 混用 */
  startTs: number
  /** 收到事件的墙钟时间：只用于 sweep 判断挂了多久 */
  receivedAtMs: number
  status?: number
  ttfbMs?: number
  cached?: boolean
  /** 已经因为重定向/停止而结过账，后续事件直接忽略 */
  done: boolean
}

export interface RequestTrackerOptions {
  /** 是否保留完整 URL（隐私默认关闭，只留 host） */
  storeUrls?: boolean
  /** 每结出一条请求回调一次；用于实时推 SSE 与维护计数 */
  onRequest?: (req: CapturedRequest) => void
  /** 超过这个时长仍未 loadingFinished 的请求，sweep 时按已测得的部分结账 */
  stuckMs?: number
}

const DEFAULT_STUCK_MS = 60_000

/**
 * 把 Network.* 事件流翻译成 CapturedRequest。
 *
 * 一条请求的生命周期：requestWillBeSent（记下起点/类型）→ responseReceived
 * （拿状态码、timing、缓存标记）→ loadingFinished（算总耗时、字节数）。
 * loadingFailed 走另一条出口。重定向会产生多条 requestWillBeSent，前一条
 * 用 redirectResponse 结账，避免把 302 的耗时算到最后一次跳转头上。
 */
export class RequestTracker {
  /** 已结账的请求，按到达顺序 */
  readonly entries: CapturedRequest[] = []

  private inflight = new Map<string, Inflight>()
  private epoch = 0
  private readonly options: RequestTrackerOptions
  private readonly stuckMs: number

  // 不用构造函数参数属性：Node 的 --experimental-strip-types 只做类型剥离，
  // 不支持 TS 的参数属性语法，这里保留显式赋值才能被单测直接加载。
  constructor(options: RequestTrackerOptions = {}) {
    this.options = options
    this.stuckMs = options.stuckMs ?? DEFAULT_STUCK_MS
  }

  /**
   * 换代：CDP 断线重连后，requestId 会从 1 重新开始。
   * 不清掉旧 key 的话，新请求会被当成"已存在"直接忽略，抓包看起来突然停摆。
   * 未完成的旧请求就地按已测得的数据结账，不丢已捕获的信息。
   */
  beginEpoch(): void {
    for (const item of [...this.inflight.values()]) this.finish(item, {})
    this.inflight.clear()
    this.epoch += 1
  }

  /** 处理一条 CDP 事件；不认识的事件直接忽略 */
  handle(method: string, params: unknown): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(params as CdpRequestWillBeSent)
        return
      case 'Network.responseReceived':
        this.onResponseReceived(params as CdpResponseReceived)
        return
      case 'Network.requestServedFromCache': {
        const p = params as { requestId?: string }
        const item = p.requestId ? this.inflight.get(this.key(p.requestId)) : undefined
        if (item) item.cached = true
        return
      }
      case 'Network.loadingFinished':
        this.onLoadingFinished(params as CdpLoadingFinished)
        return
      case 'Network.loadingFailed':
        this.onLoadingFailed(params as CdpLoadingFailed)
        return
      default:
        return
    }
  }

  /**
   * 把超过 stuckMs 还没结束的请求结账。
   *
   * 现实里总有请求既不 loadingFinished 也不 loadingFailed（页面被导航打断、
   * 长轮询一直挂着）。不清理的话 Map 会随着运行时间无上限增长，
   * 而一条 60s 都没结束的请求对"哪个域名慢"已经没有参考意义了。
   *
   * 用收到的墙钟时间比：CDP 的 timestamp 是浏览器进程的单调时钟，
   * 和 Date.now() 不同源，混着减会得出天文数字、把所有在途请求立刻结账。
   */
  sweep(nowMs: number = Date.now()): void {
    for (const item of [...this.inflight.values()]) {
      if (nowMs - item.receivedAtMs < this.stuckMs) continue
      this.finish(item, {})
    }
  }

  /** 停止采集时调用：把所有在途请求按已测得的数据结账，保证 /summary 有数 */
  flush(): void {
    for (const item of [...this.inflight.values()]) this.finish(item, {})
  }

  private key(requestId: string): string {
    return `${this.epoch}:${requestId}`
  }

  private onRequestWillBeSent(p: CdpRequestWillBeSent): void {
    if (!p || typeof p.requestId !== 'string') return
    const key = this.key(p.requestId)

    // 重定向：先给上一条结账（带上 3xx 状态码），再按新 URL 开一条
    const previous = this.inflight.get(key)
    if (previous) {
      const redirectStatus = p.redirectResponse?.status
      this.finish(previous, { status: redirectStatus })
    }

    const rawUrl = p.request?.url ?? ''
    const host = hostFromUrl(rawUrl)
    if (!host) return // data:/blob: 之类，记了也没用

    const item: Inflight = {
      key,
      requestId: p.requestId,
      host,
      url: this.options.storeUrls ? rawUrl : undefined,
      kind: kindFromResourceType(p.type),
      frameId: p.frameId,
      startTs: p.timestamp,
      receivedAtMs: Date.now(),
      done: false,
    }
    this.inflight.set(key, item)
  }

  private onResponseReceived(p: CdpResponseReceived): void {
    if (!p || typeof p.requestId !== 'string') return
    const item = this.inflight.get(this.key(p.requestId))
    if (!item) return
    const response = p.response
    item.status = typeof response?.status === 'number' ? response.status : item.status
    item.cached = item.cached === true || isCachedResponse(response)
    // 缓存命中不给耗时：CDP 报的 timing 在缓存场景下全是 0，留着会把 p95 拉低
    if (!item.cached) item.ttfbMs = ttfbFromTiming(response?.timing)
  }

  private onLoadingFinished(p: CdpLoadingFinished): void {
    if (!p || typeof p.requestId !== 'string') return
    const item = this.inflight.get(this.key(p.requestId))
    if (!item) return
    this.finish(item, {
      totalMs: item.cached ? undefined : elapsedMs(item.startTs, p.timestamp),
      bytes: typeof p.encodedDataLength === 'number' ? p.encodedDataLength : undefined,
    })
  }

  private onLoadingFailed(p: CdpLoadingFailed): void {
    if (!p || typeof p.requestId !== 'string') return
    const item = this.inflight.get(this.key(p.requestId))
    if (!item) return
    this.finish(item, {
      totalMs: elapsedMs(item.startTs, p.timestamp),
      // canceled（导航打断、资源被取消）不是网络问题，不标 failed，
      // 否则页面切换会凭空产生一堆"失败"，把用户引向错误的屏蔽建议
      failed: p.canceled === true ? undefined : true,
      errorText: p.canceled === true ? undefined : p.errorText,
    })
  }

  private finish(item: Inflight, extra: Partial<CapturedRequest>): void {
    if (item.done) return
    item.done = true
    this.inflight.delete(item.key)

    const req: CapturedRequest = {
      requestId: item.requestId,
      host: item.host,
      kind: item.kind,
    }
    if (item.url) req.url = item.url
    const status = extra.status ?? item.status
    if (typeof status === 'number' && status > 0) req.status = status
    if (item.ttfbMs !== undefined) req.ttfbMs = item.ttfbMs
    if (extra.totalMs !== undefined) req.totalMs = extra.totalMs
    if (extra.bytes !== undefined && extra.bytes >= 0) req.bytes = extra.bytes
    if (item.cached === true) req.cached = true
    if (extra.failed === true) req.failed = true
    if (extra.errorText) req.errorText = extra.errorText
    if (item.frameId) req.frameId = item.frameId

    this.entries.push(req)
    this.options.onRequest?.(req)
  }
}

// ---------------------------------------------------------------- 错误

/** CDP 不可达。路由层据此返回 502 + 契约里的中文提示 */
export class CdpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpUnavailableError'
  }
}

// ---------------------------------------------------------------- HTTP helpers

export interface CdpTarget {
  id: string
  type: string
  url: string
  title?: string
  webSocketDebuggerUrl?: string
}

export interface CdpVersionInfo {
  browser?: string
  webSocketDebuggerUrl?: string
}

function baseOf(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '')
}

async function cdpJson<T>(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<T> {
  const url = `${baseOf(baseUrl)}${pathname}`
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    // 连不上/超时都归为"CDP 未就绪"，把底层 reason 带上去方便排查
    const reason =
      err instanceof Error
        ? (err as { cause?: unknown }).cause instanceof Error
          ? ((err as { cause: Error }).cause.message || err.message)
          : err.message
        : String(err)
    throw new CdpUnavailableError(`CDP 请求失败：${reason}`)
  }
  if (!res.ok) throw new CdpUnavailableError(`CDP 返回 HTTP ${res.status}（${pathname}）`)
  return (await res.json()) as T
}

/** GET /json/version：既用来判可达，也用来拿浏览器版本 */
export async function getCdpVersion(
  baseUrl: string,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<CdpVersionInfo> {
  const info = await cdpJson<{ Browser?: string; webSocketDebuggerUrl?: string }>(
    baseUrl,
    '/json/version',
    {},
    timeoutMs,
  )
  if (!info?.webSocketDebuggerUrl) {
    throw new CdpUnavailableError('CDP 响应缺少 webSocketDebuggerUrl')
  }
  return { browser: info.Browser, webSocketDebuggerUrl: info.webSocketDebuggerUrl }
}

/** GET /json/list：只用来在重连时确认"我们那个标签页"还在 */
export async function listTargets(baseUrl: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<CdpTarget[]> {
  const list = await cdpJson<CdpTarget[]>(baseUrl, '/json/list', {}, timeoutMs)
  return Array.isArray(list) ? list : []
}

/**
 * 新开一个标签页。
 *
 * 一定要新开而不是复用已有标签页：复用等于接管用户正在看的页面，
 * 导航过去会直接把人家当前页面冲掉，停止时再关掉更是灾难。
 * Chrome 111 起 /json/new 拒绝 GET（防 CSRF），所以先 PUT，个别旧版本
 * 只认 GET，404/405 时降级重试一次。
 */
export async function createTarget(
  baseUrl: string,
  url = 'about:blank',
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CdpTarget> {
  const path = `/json/new?${encodeURIComponent(url)}`
  const base = baseOf(baseUrl)
  const attempt = async (method: string): Promise<CdpTarget | null> => {
    try {
      const res = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const target = (await res.json()) as CdpTarget
      return target?.id ? target : null
    } catch {
      return null
    }
  }

  const created = (await attempt('PUT')) ?? (await attempt('GET'))
  if (!created) throw new CdpUnavailableError('CDP 新建标签页失败（/json/new）')
  if (!created.webSocketDebuggerUrl) {
    throw new CdpUnavailableError('CDP 新建的标签页缺少 webSocketDebuggerUrl')
  }
  return created
}

/**
 * 关闭指定标签页。
 *
 * 只接受我们自己 /json/new 出来、记在会话里的 targetId；没有任何"关全部"的
 * 入口，也不接受空 id——空 id 拼出来的 /json/close/ 会被 Chrome 当作文档根路径。
 */
export async function closeTarget(
  baseUrl: string,
  targetId: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<void> {
  if (!targetId || targetId.includes('/')) return
  try {
    await fetch(`${baseOf(baseUrl)}/json/close/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // 标签页已经没了、浏览器正在退出都会失败；清理动作不需要向上报错
  }
}

// ---------------------------------------------------------------- WebSocket 客户端

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export interface CdpClientOptions {
  /** 单条命令超时 */
  commandTimeoutMs?: number
  /** 收到 CDP 事件（没有 id 的消息） */
  onEvent?: (method: string, params: unknown) => void
  /** 非主动关闭时回调（主动 close() 不触发） */
  onClose?: (reason: string) => void
}

/**
 * 单 target 的 CDP JSON-RPC 客户端。
 *
 * 只做四件事：连、发命令并按 id 配对、超时就 reject、连接断了把挂起的命令
 * 全部 reject（不让调用方永久 await）。重连策略放在 session.ts——那是业务决策，
 * 塞进传输层会让这个类同时承担两种职责，也很难在没有浏览器的情况下测。
 */
export class CdpClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closing = false
  private readonly wsUrl: string
  private readonly options: CdpClientOptions
  private readonly timeoutMs: number

  constructor(wsUrl: string, options: CdpClientOptions = {}) {
    this.wsUrl = wsUrl
    this.options = options
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.wsUrl)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          /* 关不掉也无所谓，反正已经判失败 */
        }
        reject(new CdpUnavailableError('CDP WebSocket 连接超时'))
      }, this.timeoutMs)

      ws.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.addEventListener('message', (event: MessageEvent) => this.onMessage(event.data))
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpUnavailableError('CDP WebSocket 连接失败'))
      })
      ws.addEventListener('close', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new CdpUnavailableError('CDP WebSocket 被关闭'))
          return
        }
        this.handleClose('CDP WebSocket 已断开')
      })
    })
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new CdpUnavailableError('CDP 连接未就绪'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpUnavailableError(`CDP ${method} 超时（>${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpUnavailableError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  close(): void {
    this.closing = true
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* 连接可能已经断了 */
      }
    }
    this.rejectAll('CDP 连接已关闭')
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let msg: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string; code?: number }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return // 半帧/脏数据，丢掉
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new CdpUnavailableError(msg.error.message || 'CDP 命令失败'))
      else pending.resolve(msg.result ?? {})
      return
    }

    if (typeof msg.method === 'string') {
      try {
        this.options.onEvent?.(msg.method, msg.params ?? {})
      } catch (err) {
        // 事件处理抛异常不能带崩整个连接，否则一条脏事件就让抓包永久停摆
        console.error('[capture] CDP 事件处理异常', err)
      }
    }
  }

  private handleClose(reason: string): void {
    const wasClosing = this.closing
    this.ws = null
    this.rejectAll(reason)
    if (!wasClosing) this.options.onClose?.(reason)
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new CdpUnavailableError(reason))
      this.pending.delete(id)
    }
  }
}
