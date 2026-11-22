/**
 * 「待确认加速」候选判定（纯函数，零 IO）。
 *
 * 目标：从抓包会话里挖出真实访问过的域名，判断哪些值得加速，
 * 但**不自动写入**——只产出建议，由用户点「采纳」。
 *
 * 为什么不能只看「DNS 是否不一致」：
 * 实测国内两家 DoH（AliDNS / DNSPod）对 CDN 域名各自返回不同边缘节点，
 * 这是正常的多 IP 轮询。cdn.jsdelivr.net 就被标成「源不一致」，
 * 但它的 11 个候选 IP 全部握手成功——照那个信号自动加速，
 * 等于把正常走多节点的域名人为钉死到一个 IP，反而更慢。
 *
 * 所以判定分两层：
 *   第一层（硬门槛）：有没有 IP 能完成 TLS 握手。
 *                    没有 → 无论 DNS 怎么不一致都不能加速（改 hosts 无效）。
 *   第二层（收益判断）：有可用 IP 时，加速是否真的更快。
 *                    只有「系统当前解析到的 IP 连不上/明显更慢」才值得写。
 */

export interface CandidateInput {
  domain: string
  /** 系统当前解析出的地址（走本机 DNS） */
  systemIps: readonly string[]
  /** 系统解析的地址里，能完成 TLS 握手的最快耗时；都没有则为 null */
  systemBestMs: number | null
  /** 候选里最优 IP 的耗时（TCP+TLS+TTFB）；没有可用 IP 为 null */
  bestIpMs: number | null
  /** 有多家 DoH 结果不一致（弱信号，仅作展示依据） */
  inconsistent: boolean
  /** 系统解析结果不在 DoH 候选集里（中等强度，说明系统 DNS 可能被劫持） */
  systemDiffers: boolean
  /** 是否已在加速列表（内建或自定义） */
  alreadyAccelerated: boolean
  /** 是否已在屏蔽清单 */
  alreadyBlocked: boolean
  /** 是否已判 SNI 阻断 */
  sniBlocked: boolean
}

export type CandidateVerdict =
  /** 建议加速：系统解析不可用或明显更慢，而候选里有可用且更快的 IP */
  | 'recommend'
  /** 无需处理：系统解析本来就通且不慢 */
  | 'noop'
  /** 无法加速：没有候选 IP 能握手，改 hosts 无效 */
  | 'unusable'
  /** 已处理：已在加速列表或屏蔽清单 */
  | 'handled'
  /** 证据不足：无法判断收益 */
  | 'unclear'

export interface CandidateResult {
  verdict: CandidateVerdict
  /** 给用户看的一句话依据 */
  reason: string
  /** 预估收益（毫秒），仅 recommend 时有值；无对照时为 null */
  gainMs: number | null
}

/**
 * 判定阈值：候选比系统当前快多少才算「值得加速」。
 *
 * 设 80ms 而不是 0，是为了过滤测量噪声——同一 IP 连续测两次差 30ms 很常见，
 * 为了几十毫秒改写 hosts 不划算，而且会牺牲 CDN 的多节点调度能力。
 */
export const MIN_GAIN_MS = 80

export function judgeCandidate(input: CandidateInput): CandidateResult {
  if (input.alreadyBlocked) {
    return { verdict: 'handled', reason: '已在屏蔽清单，不参与加速', gainMs: null }
  }
  if (input.alreadyAccelerated) {
    return { verdict: 'handled', reason: '已在加速列表（内建或手动添加）', gainMs: null }
  }
  if (input.sniBlocked) {
    return {
      verdict: 'unusable',
      reason: 'SNI 阻断：换 DNS 无效，只能走代理',
      gainMs: null,
    }
  }
  if (input.bestIpMs === null) {
    return {
      verdict: 'unusable',
      reason: '所有候选 IP 都无法完成 TLS 握手，写入 hosts 会让域名无法访问',
      gainMs: null,
    }
  }

  const systemMs = input.systemBestMs
  if (systemMs === null) {
    return {
      verdict: 'recommend',
      reason:
        '系统当前解析到的地址全部连不上，而候选里有可用 IP' +
        (input.systemDiffers ? '；系统解析结果不在 DoH 候选集内，疑似被劫持' : ''),
      gainMs: null,
    }
  }

  const gain = systemMs - input.bestIpMs
  if (gain >= MIN_GAIN_MS) {
    const pct = Math.round((gain / systemMs) * 100)
    return {
      verdict: 'recommend',
      reason: `候选 IP 比当前解析快 ${gain}ms（${pct}%）`,
      gainMs: gain,
    }
  }

  if (input.inconsistent && !input.systemDiffers) {
    return {
      verdict: 'noop',
      reason:
        '多家 DNS 返回不同 IP，但系统当前解析可用且不慢——这是 CDN 正常的多节点调度，不建议固定到单个 IP',
      gainMs: null,
    }
  }

  return {
    verdict: 'noop',
    reason: `当前解析可用，提速不足 ${MIN_GAIN_MS}ms，改写 hosts 收益不明显`,
    gainMs: gain > 0 ? gain : null,
  }
}
