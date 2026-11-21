/**
 * 延迟诊断的多轮计时结果排序。
 *
 * 之前只按平均耗时排，结果出现「33% 成功率、1.2s」的 IP 被推荐，
 * 而「100% 成功率、1.7s」的稳定 IP 排在后面——点一下推荐就写进 hosts，
 * 用户遇到的是三次里两次连不上，体感远差于慢几百毫秒。
 *
 * 排序规则（优先级从高到低）：
 *   1. 测不出平均耗时的排最后
 *   2. 成功率高优先（连接质量是门槛，不是仅供参考的一列）
 *   3. 同成功率按平均耗时升序
 *   4. 再同按最快一次耗时升序（稳定中的稳定）
 *
 * 纯函数，便于单测；调用方只负责把 details 传进来。
 */
export interface TimingDetail {
  ip: string
  avgTotalMs: number | null
  bestTotalMs: number | null
  okRate: number
}

export function rankTimingDetails<T extends TimingDetail>(details: T[]): T[] {
  return [...details].sort((a, b) => {
    if (a.avgTotalMs === null && b.avgTotalMs === null) return 0
    if (a.avgTotalMs === null) return 1
    if (b.avgTotalMs === null) return -1

    // 连接质量优先：100% 稳定永远排在低成功率前面，哪怕慢一点
    if (a.okRate !== b.okRate) return b.okRate - a.okRate

    if (a.avgTotalMs !== b.avgTotalMs) return a.avgTotalMs - b.avgTotalMs

    const aBest = a.bestTotalMs ?? Infinity
    const bBest = b.bestTotalMs ?? Infinity
    if (aBest !== bBest) return aBest - bBest
    return a.ip.localeCompare(b.ip)
  })
}
