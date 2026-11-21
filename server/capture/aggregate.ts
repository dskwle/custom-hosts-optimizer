// 抓包明细 → 按域名聚合（纯函数，零 IO）。
//
// 判定口径严格照 docs/orchestration/contracts/api-capture.md §1：
//   SLOW    = ttfbMs > 5000 || totalMs > 5000
//   TIMEOUT = failed && errorText 匹配一组网络错误
//   CACHED  = cached === true  → ttfb/total 不参与耗时统计，但计入请求数
//   p95     = 排序后取 95% 分位（最近秩法，不足 1 条时返回该值）
// 阈值可用环境变量 CAPTURE_SLOW_MS 覆盖（F2 调参用）。

import type { CapturedRequest, HostSummary, RequestKind } from './types.ts'

// ---------------------------------------------------------------- 阈值

export const DEFAULT_SLOW_MS = 5000

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** SLOW 阈值（毫秒），默认 5000，可通过 CAPTURE_SLOW_MS 覆盖 */
export const SLOW_MS = envPositiveNumber('CAPTURE_SLOW_MS', DEFAULT_SLOW_MS)

// ---------------------------------------------------------------- 判定谓词

const TIMEOUT_PATTERN =
  /ERR_TIMED_OUT|ERR_CONNECTION_(RESET|REFUSED|ABORTED)|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE/

/** 缓存命中：不计入耗时统计 */
export function isCached(req: CapturedRequest): boolean {
  return req.cached === true
}

/** 慢请求：首字节或总耗时超过阈值。缓存命中不带耗时，天然为 false */
export function isSlow(req: CapturedRequest, slowMs: number = SLOW_MS): boolean {
  return (req.ttfbMs ?? 0) > slowMs || (req.totalMs ?? 0) > slowMs
}

/** 失败且错误码属于「网络层拿不到响应」，改 hosts / 走代理可能有效 */
export function isTimeout(req: CapturedRequest): boolean {
  return req.failed === true && TIMEOUT_PATTERN.test(req.errorText ?? '')
}

// ---------------------------------------------------------------- 域名与第一方/第三方

/**
 * 精简的多级公共后缀表（不引 tldts 等依赖）。
 * 匹配规则：取主机名尾部标签逐级比对，命中则注册域 = 后缀 + 再前一节。
 * 未命中兜底取末两段——对绝大多数 .com/.net/.org 站点足够。
 */
const MULTI_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  // 英国
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  // 中国
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  // 澳大利亚 / 新西兰
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz',
  // 日韩
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr',
  // 香港 / 台湾 / 新加坡 / 马来西亚
  'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.ph', 'co.id', 'co.th', 'com.vn',
  // 美洲 / 欧洲 / 中东
  'com.br', 'com.ar', 'com.mx', 'com.tr', 'com.pl', 'com.ua', 'co.in', 'co.za',
  'co.il', 'com.sa', 'com.eg',
  // 托管平台（每个子域就是独立站点）
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'workers.dev', 'herokuapp.com', 'blogspot.com',
])

/** 归一化主机名：小写、去端口、去尾部点。IPv6 原样返回 */
export function normalizeHost(raw: string): string {
  let host = (raw ?? '').trim().toLowerCase()
  if (!host) return ''
  if (host.startsWith('[')) {
    // [::1]:8080 → [::1]
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colons = host.split(':').length - 1
  if (colons === 1) host = host.slice(0, host.indexOf(':')) // host:port
  else if (colons > 1) return host // 裸 IPv6
  return host.replace(/\.+$/, '')
}

export function isIpHost(host: string): boolean {
  if (!host) return false
  if (host.startsWith('[')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':')
}

/** 注册域（可注册的域名，eTLD+1）；IP 与单段主机原样返回 */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host)
  if (!h || isIpHost(h)) return h
  const labels = h.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  // 从最长到最短尝试多级后缀
  for (let take = Math.min(4, labels.length - 1); take >= 2; take--) {
    const suffix = labels.slice(-take).join('.')
    if (MULTI_LEVEL_SUFFIXES.has(suffix)) {
      return labels.slice(-(take + 1)).join('.')
    }
  }
  return labels.slice(-2).join('.')
}

/**
 * 是否第三方：注册域不同即第三方；pageHost 缺失时保守判为第一方
 * （宁可漏报也不给用户错误的屏蔽建议）。
 */
export function thirdParty(host: string, pageHost: string): boolean {
  const a = registrableDomain(host)
  const b = registrableDomain(pageHost)
  if (!a || !b) return false
  return a !== b
}

// ---------------------------------------------------------------- 聚合

const KIND_ORDER: readonly RequestKind[] = [
  'document', 'script', 'xhr', 'img', 'font', 'media', 'other',
]

/** 最近秩法分位；空样本返回 undefined */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((x, y) => x - y)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[idx])
}

/** 中位数；偶数条取中间两者均值（不取整，调用方决定展示精度） */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 从首个 document 请求推断页面主机 */
export function inferPageHost(requests: readonly CapturedRequest[]): string {
  for (const req of requests) {
    if (req.kind !== 'document') continue
    const host = normalizeHost(req.host)
    if (host) return host
  }
  return ''
}

interface Bucket {
  host: string
  requests: number
  failures: number
  timeouts: number
  ttfb: number[]
  total: number[]
  bytes: number
  kinds: Set<RequestKind>
}

function p95(values: readonly number[]): number | undefined {
  return percentile(values, 0.95)
}

function slowest(summary: HostSummary): number {
  return summary.p95TtfbMs ?? summary.p95TotalMs ?? 0
}

/**
 * 按 host 聚合请求明细。
 *
 * - 请求数含缓存命中，失败数单独累计；timeouts 是 failures 的子集（契约 v1.1）
 * - p50/p95 TTFB 与 p95 总耗时只统计非缓存、且有对应耗时的请求
 * - bytes 累计全部请求（缓存请求也代表真实资源体积）
 * - verdict 默认 'unknown'、reason 空串；建议由 advice.ts 的 advise/summarize 填充
 * - 排序：慢的在前（p95 TTFB，退化到 p95 总耗时），再按请求数降序，最后按域名升序
 *
 * @param pageHost 页面主机，用于第三方判定；缺省时取首个 document 请求的 host
 */
export function aggregate(requests: readonly CapturedRequest[], pageHost = ''): HostSummary[] {
  const page = normalizeHost(pageHost) || inferPageHost(requests)
  const buckets = new Map<string, Bucket>()

  for (const req of requests) {
    const host = normalizeHost(req.host)
    if (!host) continue // 无法定位的请求无法据此改 hosts，直接丢弃
    let bucket = buckets.get(host)
    if (!bucket) {
      bucket = { host, requests: 0, failures: 0, timeouts: 0, ttfb: [], total: [], bytes: 0, kinds: new Set() }
      buckets.set(host, bucket)
    }
    bucket.requests += 1
    if (req.failed === true) {
      bucket.failures += 1
      if (isTimeout(req)) bucket.timeouts += 1 // timeouts 是 failures 的子集
    }
    if (typeof req.bytes === 'number' && Number.isFinite(req.bytes)) bucket.bytes += req.bytes
    bucket.kinds.add(req.kind)
    if (isCached(req)) continue // 缓存命中：计入请求数，不参与耗时统计
    if (typeof req.ttfbMs === 'number' && Number.isFinite(req.ttfbMs)) bucket.ttfb.push(req.ttfbMs)
    if (typeof req.totalMs === 'number' && Number.isFinite(req.totalMs)) bucket.total.push(req.totalMs)
  }

  const summaries: HostSummary[] = []
  for (const bucket of buckets.values()) {
    const summary: HostSummary = {
      host: bucket.host,
      requests: bucket.requests,
      failures: bucket.failures,
      timeouts: bucket.timeouts,
      bytes: bucket.bytes,
      thirdParty: thirdParty(bucket.host, page),
      kinds: KIND_ORDER.filter((kind) => bucket.kinds.has(kind)),
      verdict: 'unknown',
      reason: '',
      suggested: false,
    }
    const p50Ttfb = median(bucket.ttfb)
    const p95Ttfb = p95(bucket.ttfb)
    const p95Total = p95(bucket.total)
    if (p50Ttfb !== undefined) summary.p50TtfbMs = Math.round(p50Ttfb)
    if (p95Ttfb !== undefined) summary.p95TtfbMs = p95Ttfb
    if (p95Total !== undefined) summary.p95TotalMs = p95Total
    summaries.push(summary)
  }

  summaries.sort((a, b) => {
    const delta = slowest(b) - slowest(a)
    if (delta !== 0) return delta
    if (b.requests !== a.requests) return b.requests - a.requests
    return a.host.localeCompare(b.host)
  })
  return summaries
}