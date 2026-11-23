/**
 * 自定义域名的优先级与分组归属（纯函数，零 IO）。
 *
 * 需求：自定义的域名优先级最高；如果某个域名在其它规则（内置站点组）里已存在，
 * 以自定义的为准；并且可以指定它出现在哪些分组，支持多选或全部分组。
 *
 * 这里的核心难点不是"覆盖 IP"（那很简单），而是**分组归属**：
 * 一个域名可能既在内置分组里，又被用户加成了自定义。
 * 三种情形都要能正确表达：
 *
 *   1. 只覆盖 IP，分组沿用内置的（用户只想换个地址）
 *   2. 覆盖 IP 且强制归入指定分组（用户想把它挪到自己的分类里）
 *   3. 不在任何内置分组里的纯自定义域名（必须独立归类，不能丢）
 */

/**
 * 分组特殊值：表示全部分组。
 *
 * 这里刻意不从 services/hosts.ts 导入——那个模块会拖进 constants、
 * KV 访问等一整条链，纯函数没必要为此付出加载成本，也没必要在单测里
 * 依赖运行时环境。值必须与 services/hosts.ts 的 GROUP_ALL 保持一致。
 */
const GROUP_ALL = 'all'

/** 参与合并的输入 */
export interface MergeInput {
  /** 域名 → 优选 IP（来自内置站点组解析结果） */
  builtin: ReadonlyMap<string, string>
  /** 域名 → 内置所属分组 id（一个域名可能属于多个组） */
  builtinGroups: ReadonlyMap<string, string[]>
  /**
   * 自定义条目。
   * ips 为多地址（已含族补齐）；为兼容旧调用方也接受单个 ip。
   */
  custom: ReadonlyArray<{
    domain: string
    ip?: string
    ips?: string[]
    groups?: string[]
  }>
  /** 合法分组 id 集合 */
  validGroupIds: ReadonlySet<string>
}

export interface MergedEntry {
  domain: string
  /** 全部地址（v4 在前）。第一个即主地址 */
  ips: string[]
  /** 主地址，等价 ips[0]，保留以便旧调用方 */
  ip: string
  /** 归属分组；空数组表示不属于任何已知分组（纯自定义） */
  groups: string[]
  /** 来源：custom 覆盖了内置同名条目 */
  overrode: boolean
  /** 该条目的 IP 是否来自自定义（即用户手填/自定义解析） */
  fromCustom: boolean
}

/**
 * 解析一条自定义域名的分组归属。
 *
 * @returns 生效分组；null 表示"全部分组"
 */
export function resolveGroups(
  groups: string[] | undefined | null,
  validIds: ReadonlySet<string>,
): Set<string> | null {
  if (!groups || !groups.length) return null
  const cleaned = groups.map((g) => String(g ?? '').trim().toLowerCase()).filter(Boolean)
  if (!cleaned.length) return null
  if (cleaned.includes(GROUP_ALL)) return null
  const picked = cleaned.filter((g) => validIds.has(g))
  // 全是非法 id 时按"全部分组"兜底：
  // 宁可多显示一处，也不要让用户加的域名在界面上凭空消失
  return picked.length ? new Set(picked) : null
}

/**
 * 合并内置与自定义，产出最终条目。
 *
 * 优先级规则（重要）：
 *   - IP：自定义 > 内置。用户手填的地址永远赢。
 *   - 分组：自定义显式指定了分组就用它；没指定则沿用内置的分组；
 *           两者都没有则归为"纯自定义"。
 *
 * 返回按域名排序，保证输出稳定（同样的输入永远得到同样的顺序，
 * 便于 diff 和缓存）。
 */
export function mergeCustomWithBuiltin(input: MergeInput): MergedEntry[] {
  const { builtin, builtinGroups, custom, validGroupIds } = input
  const out = new Map<string, MergedEntry>()

  // 先铺内置
  for (const [domain, ip] of builtin) {
    const key = domain.toLowerCase()
    out.set(key, {
      domain: key,
      ips: [ip],
      ip,
      groups: builtinGroups.get(key) ?? [],
      overrode: false,
      fromCustom: false,
    })
  }

  // 自定义逐条覆盖
  for (const c of custom) {
    const key = String(c.domain || '').trim().toLowerCase()
    if (!key) continue
    const existed = out.get(key)
    const declared = resolveGroups(c.groups, validGroupIds)

    let groups: string[]
    if (declared === null) {
      // 没指定分组（或指定了 all）：沿用内置归属；内置没有就是纯自定义
      groups = existed ? existed.groups : []
      // 但若该域名属于内置分组、用户没指定，仍然保留内置归属 —— 这正是"只换 IP"的场景
      if (!groups.length) groups = builtinGroups.get(key) ?? []
    } else {
      groups = [...declared]
    }

    // 自定义的多地址整组替换内置的单地址
    const ips = (c.ips?.length ? c.ips : c.ip ? [c.ip] : []).filter(Boolean)

    out.set(key, {
      domain: key,
      ips: ips.length ? ips : [c.ip ?? ""].filter(Boolean),
      ip: (ips.length ? ips : [c.ip ?? ""])[0] ?? "",
      groups,
      overrode: Boolean(existed),
      fromCustom: true,
    })
  }

  return [...out.values()].sort((a, b) => a.domain.localeCompare(b.domain))
}

/** 统计每个分组下的条目数（供界面/接口展示） */
export function countByGroup(
  entries: readonly MergedEntry[],
): Map<string, number> {
  const m = new Map<string, number>()
  for (const e of entries) {
    for (const g of e.groups) m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/**
 * 按分组筛选条目。
 *
 * 语义：条目只要**包含**该分组就选中。
 * 属于"全部分组"的条目不特殊处理——它们在合并阶段已经被展开成具体分组列表，
 * 或者本来就是纯自定义（groups 为空），此时任何分组筛选都不匹配它们，
 * 由调用方决定是否用 includeUngrouped 兜底。
 */
export function filterByGroup(
  entries: readonly MergedEntry[],
  groupId: string,
  includeUngrouped = false,
): MergedEntry[] {
  const g = groupId.toLowerCase()
  return entries.filter((e) =>
    e.groups.length === 0 ? includeUngrouped : e.groups.includes(g),
  )
}
