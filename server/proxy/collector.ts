/**
 * 代理连接采集会话。
 *
 * 轮询 mihomo 的 /connections 拿当前活跃连接，交给 ProxyAggregator 累积。
 *
 * 为什么用轮询而不是 WebSocket：
 *   /connections 本身是快照接口，WebSocket 也只是把同一份数据推过来，
 *   实现却要处理断线重连、消息乱序。5 秒轮询足以覆盖绝大多数连接
 *   （mihomo 的连接通常持续数秒以上），复杂度低一个量级。
 *
 * 代价：存活时间 <5 秒的短连接可能整条错过。这是刻意接受的损失——
 * 短连接通常也不是我们关心的广告流量（广告 SDK 的连接会持续更久）。
 */
import { ProxyAggregator, type HostStat, type RawConnection } from './aggregate.ts'

export interface ProxyCollectorConfig {
  /** mihomo 控制接口，如 http://192.168.6.5:9090 */
  baseUrl: string
  /** external-controller 的 secret */
  secret: string
  /** 轮询间隔，默认 5s */
  intervalMs: number
}

export interface ProxySessionState {
  id: string
  status: 'idle' | 'running' | 'stopped'
  startedAt: string | null
  endedAt: string | null
  /** 轮询次数 */
  polls: number
  /** 累计独立连接数 */
  totalConnections: number
  /** 当前域名数 */
  hostCount: number
  /** 最近一次错误（mihomo 不可达时的提示） */
  error: string | null
  /** 上次轮询时间 */
  lastPollAt: string | null
}

const DEFAULT_INTERVAL = 5_000
const FETCH_TIMEOUT = 8_000

export class ProxyCollector {
  private readonly cfg: ProxyCollectorConfig
  private readonly agg = new ProxyAggregator()
  private timer: ReturnType<typeof setInterval> | null = null
  private state: ProxySessionState

  constructor(cfg: ProxyCollectorConfig) {
    this.cfg = { ...cfg, intervalMs: cfg.intervalMs || DEFAULT_INTERVAL }
    this.state = {
      id: `proxy-${Date.now().toString(36)}`,
      status: 'idle',
      startedAt: null,
      endedAt: null,
      polls: 0,
      totalConnections: 0,
      hostCount: 0,
      error: null,
      lastPollAt: null,
    }
  }

  status(): ProxySessionState {
    return { ...this.state, hostCount: this.agg.size, totalConnections: this.agg.totalConnections }
  }

  start(): ProxySessionState {
    if (this.timer) return this.status()
    this.state = {
      ...this.state,
      id: `proxy-${Date.now().toString(36)}`,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      polls: 0,
      error: null,
    }
    // 先立即拉一次，别让用户等一个完整间隔
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.cfg.intervalMs)
    return this.status()
  }

  stop(): ProxySessionState {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.state = { ...this.state, status: 'stopped', endedAt: new Date().toISOString() }
    return this.status()
  }

  /** 清空累积数据，但保持运行状态不变 */
  clear(): void {
    this.agg.clear()
    this.state = { ...this.state, totalConnections: 0, polls: 0 }
  }

  hosts(): HostStat[] {
    return this.agg.list()
  }

  /** 供识别流水线取域名 */
  hostNames(): string[] {
    return this.agg.hosts()
  }

  /** mihomo 是否可达（探一次，用于界面显示） */
  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/version`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })
      if (!res.ok) {
        return { ok: false, error: res.status === 401 ? 'secret 不正确' : `HTTP ${res.status}` }
      }
      const d = (await res.json()) as { version?: string }
      return { ok: true, version: d.version }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private headers(): Record<string, string> {
    return this.cfg.secret ? { Authorization: `Bearer ${this.cfg.secret}` } : {}
  }

  private async poll(): Promise<void> {
    if (this.state.status !== 'running') return
    try {
      const res = await fetch(`${this.cfg.baseUrl}/connections`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })
      if (!res.ok) {
        this.state = {
          ...this.state,
          error: res.status === 401 ? 'secret 不正确' : `HTTP ${res.status}`,
          lastPollAt: new Date().toISOString(),
        }
        return
      }
      const d = (await res.json()) as { connections?: RawConnection[] }
      this.agg.ingest(d.connections || [])
      this.state = {
        ...this.state,
        polls: this.state.polls + 1,
        error: null,
        lastPollAt: new Date().toISOString(),
        totalConnections: this.agg.totalConnections,
        hostCount: this.agg.size,
      }
    } catch (err) {
      // 采集中断不该让整个服务异常：记下错误，下一轮继续试
      this.state = {
        ...this.state,
        error: err instanceof Error ? err.message : String(err),
        lastPollAt: new Date().toISOString(),
      }
    }
  }
}

/** 从环境变量构造：未配置时给出明确提示而不是静默失败 */
export function createCollectorFromEnv(): ProxyCollector {
  const baseUrl = (process.env.MIHOMO_API || 'http://127.0.0.1:9090').replace(/\/$/, '')
  const secret = process.env.MIHOMO_SECRET || ''
  const interval = Number(process.env.PROXY_POLL_MS || DEFAULT_INTERVAL)
  return new ProxyCollector({
    baseUrl,
    secret,
    intervalMs: Number.isFinite(interval) && interval >= 1000 ? interval : DEFAULT_INTERVAL,
  })
}
