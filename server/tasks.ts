/**
 * 后台任务管理：让刷新/探测这类耗时任务可以「发起后立刻返回」，
 * 前端通过轮询 /local/tasks 拿进度，而不是干等一个长请求。
 *
 * 同时承担长时间监控的调度：按固定间隔反复采样，
 * 把每次结果追加到时序记录里，用于观察延迟随时间的变化。
 */
import { EventEmitter } from "node:events"

export type TaskState = "pending" | "running" | "done" | "failed" | "cancelled"

export interface TaskProgress {
  taskId: string
  kind: "refresh" | "monitor" | "timing"
  state: TaskState
  total: number
  done: number
  failed: number
  /** 当前正在处理的域名 */
  current: string | null
  startedAt: number
  finishedAt: number | null
  /** 最近若干条结果，供前端实时展示 */
  recent: TaskItemResult[]
  message?: string
  error?: string
}

export interface TaskItemResult {
  domain: string
  ok: boolean
  bestIp: string | null
  /** 双栈时第二族（IPv6）的优选地址；仅 v4/v6 都可用时存在 */
  bestIpV6?: string
  /** v4 可用但 v6 全废，输出时会补一条 :: 屏蔽 */
  v6OnlyBroken?: boolean
  /** 最优 IP 的地址族 */
  family?: "v4" | "v6"
  latency: number | null
  /** TLS 握手是否成功。false 表示该域名本次没有可用 IP */
  tlsOk?: boolean
  /** 候选 IP 总数 / TLS 成功数，便于看出筛选比例 */
  candidateCount?: number
  tlsOkCount?: number
  /** 本次从缓存复用的候选数 */
  cacheHits?: number
  /** 最优 IP 的 TLS 握手耗时 */
  tlsMs?: number | null
  /** 失败原因汇总，用于在列表上直接说明为什么不可用 */
  error?: string
  /** 本项目顺带写入自定义域名的结果（仅延迟检测的可选行为） */
  adopted?: "added" | "updated" | "skipped" | "failed"
  /** 完整探测结果：各 DoH 明细、全部候选、SNI 判定。
   *  批量刷新把每个域名的详情都带回来，前端点开即可看到与单次检测一致的信息 */
  detail?: {
    providers: { name: string; ips: string[]; ms: number | null; error?: string }[]
    candidates: {
      ip: string
      family: "v4" | "v6"
      latency: number | null
      tlsOk: boolean
      tlsMs: number | null
      tlsError?: string
    }[]
    /** IPv4 / IPv6 候选数量 */
    v4Count?: number
    v6Count?: number
    systemIps: string[]
    /** 绕过 hosts 的上游解析结果，用于对照 */
    upstreamIps?: string[]
    /** 该域名是否被 /etc/hosts 覆盖 */
    hostsOverride?: boolean
    inconsistent: boolean
    systemDiffers: boolean
    totalResolvedEntries: number
    sni?: {
      verdict: string
      explanation: string
      withSni: { ok: boolean; ms: number | null; error?: string }
      withoutSni: { ok: boolean; ms: number | null; error?: string }
    } | null
  }
  source: "local" | "probe"
}

/** 时序采样点，用于长时间监控 */
export interface SamplePoint {
  ts: number
  /** 域名 -> 该时刻的最优延迟 */
  values: Record<string, number | null>
}

// 保留全部结果供前端查看。137 个域名的详情约几 MB，
// 单个任务持有这么多内存可以接受；上限设为 500 防止异常情况无限增长。
const MAX_RECENT = 500

class TaskManager extends EventEmitter {
  private tasks = new Map<string, TaskProgress>()
  /** domain -> 时间序列，最多保留 MAX_POINTS 个点 */
  private series = new Map<string, SamplePoint[]>()
  private readonly MAX_POINTS = 2000
  private readonly MAX_TASKS = 50

  create(kind: "refresh" | "monitor" | "timing", total: number): TaskProgress {
    const taskId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const task: TaskProgress = {
      taskId,
      kind,
      state: "pending",
      total,
      done: 0,
      failed: 0,
      current: null,
      startedAt: Date.now(),
      finishedAt: null,
      recent: [],
    }
    this.tasks.set(taskId, task)
    // 清理旧任务，避免内存无限增长
    if (this.tasks.size > this.MAX_TASKS) {
      const oldest = [...this.tasks.entries()]
        .sort((a, b) => a[1].startedAt - b[1].startedAt)
        .slice(0, this.tasks.size - this.MAX_TASKS)
      for (const [id] of oldest) this.tasks.delete(id)
    }
    return task
  }

  get(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId)
  }

  list(): TaskProgress[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  update(taskId: string, patch: Partial<TaskProgress>): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    Object.assign(task, patch)
    this.emit("progress", task)
  }

  startItem(taskId: string, domain: string): void {
    this.update(taskId, { state: "running", current: domain })
  }

  finishItem(taskId: string, item: TaskItemResult): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.done++
    if (!item.ok) task.failed++
    task.recent.push(item)
    if (task.recent.length > MAX_RECENT) task.recent.shift()
    this.emit("progress", task)
  }

  complete(taskId: string, message?: string): void {
    this.update(taskId, {
      state: "done",
      finishedAt: Date.now(),
      current: null,
      message,
    })
  }

  fail(taskId: string, error: string): void {
    this.update(taskId, {
      state: "failed",
      finishedAt: Date.now(),
      current: null,
      error,
    })
  }

  /** 记录一次采样，供趋势图使用 */
  recordSample(values: Record<string, number | null>): void {
    const point: SamplePoint = { ts: Date.now(), values }
    for (const [domain, latency] of Object.entries(values)) {
      const arr = this.series.get(domain) || []
      arr.push({ ts: point.ts, values: { [domain]: latency } })
      if (arr.length > this.MAX_POINTS) arr.splice(0, arr.length - this.MAX_POINTS)
      this.series.set(domain, arr)
    }
  }

  getSeries(domains: string[], limit = 200): Record<string, { ts: number; v: number | null }[]> {
    const out: Record<string, { ts: number; v: number | null }[]> = {}
    for (const d of domains) {
      const arr = this.series.get(d) || []
      out[d] = arr.slice(-limit).map((p) => ({ ts: p.ts, v: p.values[d] ?? null }))
    }
    return out
  }

  clearSeries(): void {
    this.series.clear()
  }

  seriesSize(): number {
    return this.series.size
  }
}

export const taskManager = new TaskManager()

/** 长时间监控的调度器：按间隔反复采样，直到被停止 */
class Monitor {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private domainSource: () => string[] = () => []
  private sampler: (domain: string) => Promise<TaskItemResult> = async () => ({
    domain: "",
    ok: false,
    bestIp: null,
    latency: null,
    source: "probe",
  })
  private taskId: string | null = null
  private intervalMs = 5 * 60 * 1000
  private concurrency = 8

  configure(opts: {
    domainSource: () => string[]
    sampler: (domain: string) => Promise<TaskItemResult>
    intervalMs?: number
    concurrency?: number
  }) {
    this.domainSource = opts.domainSource
    this.sampler = opts.sampler
    if (opts.intervalMs) this.intervalMs = opts.intervalMs
    if (opts.concurrency) this.concurrency = opts.concurrency
  }

  isRunning(): boolean {
    return this.running
  }

  status() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      concurrency: this.concurrency,
      taskId: this.taskId,
      seriesDomains: taskManager.seriesSize(),
    }
  }

  async tick(): Promise<void> {
    const domains = this.domainSource()
    if (domains.length === 0) return

    const task = taskManager.create("monitor", domains.length)
    this.taskId = task.taskId

    const values: Record<string, number | null> = {}
    let index = 0

    const workers = Array.from(
      { length: Math.min(this.concurrency, domains.length) },
      async () => {
        while (true) {
          const i = index++
          if (i >= domains.length) return
          const domain = domains[i]
          taskManager.startItem(task.taskId, domain)
          try {
            const r = await this.sampler(domain)
            values[domain] = r.latency
            taskManager.finishItem(task.taskId, r)
          } catch (err) {
            values[domain] = null
            taskManager.finishItem(task.taskId, {
              domain,
              ok: false,
              bestIp: null,
              latency: null,
              source: "probe",
            })
          }
        }
      }
    )
    await Promise.all(workers)

    taskManager.recordSample(values)
    taskManager.complete(task.taskId, `sampled ${domains.length} domains`)
  }

  start(intervalMs?: number): boolean {
    if (this.running) return false
    if (intervalMs) this.intervalMs = intervalMs
    this.running = true
    // 立即跑一次，随后按间隔重复
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    return true
  }

  stop(): boolean {
    if (!this.running) return false
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return true
  }
}

export const monitor = new Monitor()
