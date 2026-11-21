/**
 * SNI 阻断判定（纯函数，零 IO，便于单测）。
 *
 * 背景：判断「真实 SNI 握手失败」到底是中间设备按域名切断（SNI 阻断），
 * 还是本次网络抖动，靠的是拿一个无关域名做对照组。
 *
 * 但对照组成功并不等于目标就是 SNI 阻断 —— 真实 SNI 那一次失败的原因很关键：
 *
 *   - ECONNRESET / ECONNREFUSED / EPROTO 这类**主动断开**才是中间设备切断的特征
 *   - **握手超时**只说明这条连接没在预算内完成，可能是网络慢、丢包、
 *     服务端限流或本机连接数压力，跟域名匹配无关
 *
 * 早期没区分这一点，把超时也算成阻断，代价很大：判为 sni-blocked 的域名
 * 会被写进排除清单，后续每轮刷新都直接跳过，一个偶发超时就让它永久失去优化机会。
 * 所以超时一律降级为 unknown（结果不可采信、下次重测），不写排除清单。
 */

/** 连接被主动中断的 errno，这才是"被按域名切断"的证据 */
const RESET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
])

export function isTimeoutError(error?: string | null): boolean {
  if (!error) return false
  const s = String(error)
  return /超时|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(s)
}

export function isResetError(error?: string | null): boolean {
  if (!error) return false
  return RESET_CODES.has(String(error).trim())
}

export type SniVerdict = 'ok' | 'sni-blocked' | 'tcp-blocked' | 'unknown'

export interface SniJudgeInput {
  /** TCP 是否可达（不可达则与 SNI 无关） */
  tcpOk: boolean
  /** 真实 SNI 握手是否成功 */
  withSniOk: boolean
  /** 真实 SNI 失败原因 */
  withSniError?: string | null
  /** 对照组握手是否成功 */
  controlOk: boolean
  /** 对照组失败原因 */
  controlError?: string | null
}

export interface SniJudgeResult {
  verdict: SniVerdict
  /** 是否应写进「已排除的 SNI 阻断域名」清单 */
  addToBlocklist: boolean
  /** 为什么是这个结论，中文，可直接展示 */
  note: string
}

/**
 * 判定规则（按顺序）：
 *   1. TCP 不通            → tcp-blocked（IP 层问题，换 IP 可能好，值得重测，不入清单）
 *   2. 真实 SNI 成功        → ok
 *   3. 对照组也失败          → unknown（网络不稳，结论不可采信）
 *   4. 真实 SNI 是超时       → unknown（**不判阻断、不入清单**，下次重测）
 *   5. 真实 SNI 是主动断开且对照组成功 → sni-blocked（入清单）
 *   6. 其它失败原因          → unknown（证据不足，宁可重测也不要误封）
 */
export function judgeSni(input: SniJudgeInput): SniJudgeResult {
  if (!input.tcpOk) {
    return {
      verdict: 'tcp-blocked',
      addToBlocklist: false,
      note: 'TCP 不可达，属于 IP 层封锁或地址失效，与 SNI 无关；换 IP 仍可能可用，不入排除清单。',
    }
  }
  if (input.withSniOk) {
    return { verdict: 'ok', addToBlocklist: false, note: '真实 SNI 握手成功，不存在阻断。' }
  }
  if (!input.controlOk) {
    return {
      verdict: 'unknown',
      addToBlocklist: false,
      note: '真实 SNI 与对照 SNI 均失败，说明当前网络对外连接不稳定，本次结论不可采信。',
    }
  }
  if (isTimeoutError(input.withSniError)) {
    return {
      verdict: 'unknown',
      addToBlocklist: false,
      note:
        '真实 SNI 握手超时，而对照组成功。超时可能只是网络慢或丢包，' +
        '不能据此判定为 SNI 阻断——本次不计入排除清单，下轮刷新会重测。',
    }
  }
  if (isResetError(input.withSniError)) {
    return {
      verdict: 'sni-blocked',
      addToBlocklist: true,
      note:
        'TCP 可连接，真实 SNI 被主动切断，改用无关 SNI 则握手成功。' +
        '中间设备按域名匹配切断连接，改 hosts 无效，必须走代理。',
    }
  }
  return {
    verdict: 'unknown',
    addToBlocklist: false,
    note: `真实 SNI 失败原因为「${input.withSniError || '未知'}」，不是典型的连接被切断特征，证据不足，本轮不判定为阻断。`,
  }
}
