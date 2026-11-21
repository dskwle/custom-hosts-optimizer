/**
 * 候选 IP 的多轮连接质量测量。
 *
 * probeDomain 原本只对每个 IP 做一次 TCP + TLS 握手：握手成功就算可用，
 * 然后按 TCP 延迟挑 bestIp 写进 hosts。但「一次成功」不等于「稳定可用」——
 * 延迟诊断页就出现过 33% 成功率的 IP 因为更快被推荐的情况。
 *
 * 这里对 TLS 已握手成功的候选跑多轮完整 HTTPS 计时（TCP+TLS+TTFB），
 * 用成功率优先的规则排序，让写入 hosts 的一路也按连接质量优选。
 *
 * 成本：每个候选 rounds 次完整请求（候选之间并发，同一候选的轮次顺序执行，
 * 避免并发连接互相抢带宽导致测出来的延迟失真）。默认最多测 5 个候选。
 */
import { resolveAndMeasure } from "./timing.js"
import { rankTimingDetails } from "./rank.js"

export interface QualityCandidate {
  ip: string
}

export interface QualityResult {
  ip: string
  okRate: number
  avgTotalMs: number | null
  bestTotalMs: number | null
}

/** 对指定候选做 rounds 轮计时并返回按质量排序的结果；rounds<=1 时不做（返回空） */
export async function measureQuality(
  domain: string,
  candidates: readonly QualityCandidate[],
  options: { rounds?: number; maxCandidates?: number } = {},
): Promise<QualityResult[]> {
  const rounds = Math.max(1, options.rounds ?? 3)
  if (rounds <= 1) return []

  const pool = candidates.slice(0, options.maxCandidates ?? 5)
  if (!pool.length) return []

  const measured = await Promise.all(
    pool.map(async ({ ip }) => {
      const samples = []
      for (let i = 0; i < rounds; i += 1) {
        samples.push(await resolveAndMeasure(domain, ip, { skipDns: true }))
      }
      const ok = samples.filter((s) => s.ok && s.totalMs !== null)
      return {
        ip,
        okRate: Math.round((ok.length / rounds) * 100),
        avgTotalMs: ok.length
          ? Math.round(ok.reduce((a, s) => a + (s.totalMs ?? 0), 0) / ok.length)
          : null,
        bestTotalMs: ok.length ? Math.min(...ok.map((s) => s.totalMs ?? Infinity)) : null,
      }
    }),
  )

  return rankTimingDetails(measured)
}
