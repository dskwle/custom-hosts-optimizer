/**
 * 查询结果的「只看已暂停」过滤（纯函数）。
 *
 * 单独一个文件是因为 /local/lookup 里全是 IO 编排，
 * 这段筛选逻辑需要能脱离网络单测。
 */

export interface PausableRow {
  domain: string
  paused?: boolean
}

/**
 * @param rows 全部候选行
 * @param onlyPaused 是否只保留已暂停的内置条目
 */
export function pickPaused<T extends PausableRow>(rows: readonly T[], onlyPaused: boolean): T[] {
  if (!onlyPaused) return [...rows]
  return rows.filter((r) => r.paused === true)
}
