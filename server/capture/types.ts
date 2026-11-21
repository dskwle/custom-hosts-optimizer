// 抓包诊断的类型定义，逐字对应 docs/orchestration/contracts/api-capture.md §1。
// 契约冻结：字段增删改必须先改契约并由主 agent 批准。本文件只放 type/interface，不含运行时值。

export type CaptureStatus = 'starting' | 'running' | 'stopped' | 'failed'

export type RequestKind =
  | 'document' | 'script' | 'xhr' | 'img' | 'font' | 'media' | 'other'

export interface CaptureSession {
  id: string                 // capture-<ts>-<rand>
  url: string                // 用户输入的起始地址
  status: CaptureStatus
  startedAt: string          // ISO
  endedAt?: string
  requestCount: number
  hostCount: number
  error?: string             // status=failed 时的原因
}

export interface CapturedRequest {
  requestId: string
  host: string               // 小写，去掉端口
  url?: string               // 仅 storeUrls=true 时返回
  kind: RequestKind
  status?: number            // HTTP 状态码，失败时缺省
  ttfbMs?: number            // 首字节；缓存命中或无法测量时为 undefined
  totalMs?: number           // 请求发起到完成
  bytes?: number
  failed?: boolean
  errorText?: string         // net::ERR_TIMED_OUT 等
  cached?: boolean           // fromDiskCache / fromMemoryCache
  frameId?: string
}

export type Verdict = 'accel' | 'block' | 'proxy' | 'ignore' | 'unknown'

export interface HostSummary {
  host: string
  requests: number
  failures: number
  p50TtfbMs?: number
  p95TtfbMs?: number
  p95TotalMs?: number
  bytes: number
  thirdParty: boolean
  kinds: RequestKind[]       // 出现过的类型，去重
  verdict: Verdict
  reason: string             // 一句话依据，给用户看，中文
  suggested: boolean         // 默认是否勾选
}

export interface CaptureEnv {
  cdp: boolean               // CDP 是否可达
  version?: string           // Chromium / Chrome 版本
  chromium?: string          // 容器内浏览器标识，便于排查
  error?: string
}
