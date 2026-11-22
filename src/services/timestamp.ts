/**
 * 时间戳取值（纯函数）。
 *
 * hosts 头部时间要反映「内容最后一次变化」，而变化有两个来源：
 *   1. 全量刷新：domain_data.lastUpdated
 *   2. 手动增删自定义域名：custom_touched_at
 *
 * 之所以不把 2 写进 1，是因为后者同时是「缓存是否有效」的判据
 * （getHostsData 的 3 小时窗口）。手动加个域名就把它推到当前时间，
 * 会让本该回源的旧数据被当成新鲜的，反而掩盖真问题。
 */

/** 从若干时间字符串里取最新的一个；全部无效则返回 null */
export function pickLatest(...values: (string | null | undefined)[]): string | null {
  const valid = values.filter(
    (x): x is string => typeof x === 'string' && x.length > 0 && !Number.isNaN(Date.parse(x)),
  )
  if (!valid.length) return null
  return valid.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
}
