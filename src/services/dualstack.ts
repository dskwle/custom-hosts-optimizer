/**
 * hosts 输出的双栈辅助逻辑（纯函数，零 IO，便于单测）。
 *
 * 为什么单独一个文件：`services/hosts.ts` 里全是业务编排、还带着不带扩展名的
 * 跨目录 import，`node --experimental-strip-types` 跑不起来。这里只放
 * "按地址族过滤" 和 "仅 v6 屏蔽段" 这两块纯逻辑，测试可以直接引用。
 */

/** [地址, 域名] */
export type HostTuple = readonly [string, string]

/** 地址是否是 IPv6（hosts 里 v6 一定含冒号，v4 不含） */
export function isIpv6Addr(addr: string): boolean {
  return addr.includes(":")
}

/**
 * 纯 v4 模式：剔除所有 IPv6 行。
 *
 * 少数环境（老路由器、无 IPv6 出口的容器）把 v6 写进 hosts 反而会导致
 * 解析优先取到不可达地址，所以需要一个只含 v4 的版本。
 */
export function filterByFamily<T extends HostTuple>(entries: readonly T[], ipv4Only: boolean): T[] {
  if (!ipv4Only) return [...entries]
  return entries.filter(([ip]) => !isIpv6Addr(ip))
}

export interface V6OnlySectionOptions {
  /** 已经整域名屏蔽的集合；这些不再写 v6-only 段，避免重复 */
  blocked?: Iterable<string>
  /** 屏蔽地址前缀，默认 `::` */
  blockAddr?: string
  /** 对齐宽度 */
  pad?: number
}

/**
 * 生成「仅屏蔽 IPv6」段。
 *
 * 场景：某域名 v4 有可用优选地址，但 v6 能解析出地址却全部握手失败。
 * 此时只「不输出 v6」是不够的 —— 客户端会自己查 AAAA 拿到被污染/失效的地址，
 * 表现为偶发卡顿甚至等到超时才回落 v4。所以要显式写 `::  域名`。
 *
 * 注意不能写 `0.0.0.0`：那会把刚刚优选好的 v4 一起封掉。
 */
export function formatV6OnlySection(
  domains: readonly string[],
  options: V6OnlySectionOptions = {},
): string {
  const blocked = new Set<string>()
  for (const d of options.blocked ?? []) blocked.add(String(d).toLowerCase())

  const list = domains
    .map((d) => String(d ?? "").trim())
    .filter((d) => d && !blocked.has(d.toLowerCase()))
  if (!list.length) return ""

  const addr = options.blockAddr ?? "::"
  const pad = options.pad ?? 10

  return [
    "# ============================================================",
    "# 仅屏蔽 IPv6（这些域名的 v4 优选地址仍在上方生效）",
    "# 原因：v6 能解析出地址但全部无法握手，留空会让客户端等待超时才回落",
    `# 域名数：${list.length}`,
    "# ============================================================",
    list.map((d) => `${addr.padEnd(pad)}${d}`).join("\n"),
  ].join("\n")
}
