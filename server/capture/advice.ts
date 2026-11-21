// 从 HostSummary 生成给用户看的一句话依据 + 建议动作（纯函数，零 IO）。
//
// 规则矩阵（按优先级从上到下，命中即返回）：
//   1. ctx.sniBlocked                     → proxy，suggested=false（改 hosts 无效）
//   2. 第三方 + 有失败                     → block，suggested=true
//   3. 第三方 + 慢                         → accel，suggested=true
//   4. 第一方 + 失败/慢                    → ignore，suggested=false（改 hosts 可能无解）
//   5. 其余                               → unknown，suggested=false
//
// 参与率原则：只有 block / accel 默认为 true，且必须基于具体数字（失败数或 p95）。
// 不做「全选」式建议——用户随便全选会把正常站点也塞进 hosts，反而更慢。

import type { CapturedRequest, HostSummary, RequestKind, Verdict } from './types'
// @ts-ignore TS5097：node --experimental-strip-types 要求显式 .ts 后缀，本项目 tsconfig 未开 allowImportingTsExtensions
import { SLOW_MS, aggregate } from './aggregate.ts'

export interface AdviceContext {
  /** 页面主机，用于 summarize 时的第三方判定 */
  pageHost?: string
  /** 疑似 SNI 阻断：强制走代理，且不勾选任何 hosts 动作 */
  sniBlocked?: boolean
  /** 覆盖 SLOW 阈值（测试与 F2 调参用） */
  slowMs?: number
}

export interface Advice {
  verdict: Verdict
  reason: string
  suggested: boolean
}

const KIND_LABEL: Record<RequestKind, string> = {
  document: '文档',
  script: '脚本',
  xhr: '接口',
  img: '图片',
  font: '字体',
  media: '媒体',
  other: '资源',
}

/** 毫秒 → 秒，默认保留一位小数：8400 → "8.4s" */
function fmtSec(ms: number, digits = 1): string {
  return `${(ms / 1000).toFixed(digits)}s`
}

function kindLabel(kinds: readonly RequestKind[]): string {
  if (kinds.length === 1) return KIND_LABEL[kinds[0]]
  if (kinds.includes('script')) return '脚本'
  return '资源'
}

/**
 * 综合建议。reason 为一句中文，可直接渲染给用户。
 * 不修改入参 summary。
 */
export function advise(summary: HostSummary, ctx: AdviceContext = {}): Advice {
  const slowMs = ctx.slowMs ?? SLOW_MS
  const { requests, failures, thirdParty: isThirdParty } = summary

  if (ctx.sniBlocked) {
    return { verdict: 'proxy', reason: `${summary.host} 疑似 SNI 阻断，改 hosts 无效，建议走代理`, suggested: false }
  }

  if (requests === 0) {
    return { verdict: 'unknown', reason: '无请求数据', suggested: false }
  }

  const p95Ttfb = summary.p95TtfbMs
  const p95Total = summary.p95TotalMs
  const slow = (p95Ttfb ?? 0) > slowMs || (p95Total ?? 0) > slowMs
  const worst = Math.max(p95Ttfb ?? 0, p95Total ?? 0)
  const slowText = fmtSec(slowMs, 0)

  if (isThirdParty && failures > 0) {
    const tail = slow ? `，p95 ${fmtSec(worst)}` : ''
    return {
      verdict: 'block',
      reason: `第三方域名 ${requests} 个请求中 ${failures} 个失败${tail}`,
      suggested: true,
    }
  }

  if (isThirdParty && slow) {
    return {
      verdict: 'accel',
      reason: `第三方${kindLabel(summary.kinds)} p95 ${fmtSec(worst)}，超过 ${slowText}`,
      suggested: true,
    }
  }

  if (!isThirdParty && slow) {
    return {
      verdict: 'ignore',
      reason: `第一方 p95 ${fmtSec(worst)} 偏慢，改 hosts 可能无解（瓶颈多在源站或线路）`,
      suggested: false,
    }
  }

  if (!isThirdParty && failures > 0) {
    return {
      verdict: 'ignore',
      reason: `第一方 ${failures} 个请求失败，改 hosts 通常无解，需排查源站`,
      suggested: false,
    }
  }

  const normal = p95Ttfb ?? p95Total
  if (normal === undefined) {
    return { verdict: 'unknown', reason: `${requests} 个请求未测得耗时（缓存命中或未完成）`, suggested: false }
  }
  return { verdict: 'unknown', reason: `p95 首字节 ${fmtSec(normal)}，未见异常`, suggested: false }
}

/** 批量建议，保持输入顺序 */
export function adviseAll(summaries: readonly HostSummary[], ctx: AdviceContext = {}): HostSummary[] {
  return summaries.map((summary) => ({ ...summary, ...advise(summary, ctx) }))
}

/**
 * 一步到位：聚合 + 建议。B 侧 /summary 建议直接用这个入口，
 * 避免拿到 verdict 全是 'unknown' 的裸聚合结果。
 */
export function summarize(requests: readonly CapturedRequest[], ctx: AdviceContext = {}): HostSummary[] {
  const pageHost = ctx.pageHost ?? ''
  return adviseAll(aggregate(requests, pageHost), { ...ctx, pageHost })
}