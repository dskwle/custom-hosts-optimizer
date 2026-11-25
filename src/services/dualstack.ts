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

/* ------------------------------------------------------------------
 * 自定义域名的多地址与地址族补齐
 * ------------------------------------------------------------------ */

/** v4 的屏蔽地址：不可路由，等价于"这一族别用" */
export const BLOCK_ADDR_V4 = "0.0.0.0"
/** v6 的屏蔽地址 */
export const BLOCK_ADDR_V6 = "::"

/** 地址是否像 IPv4（四段十进制，允许带端口以外的写法都不接受） */
export function isIpv4Addr(addr: string): boolean {
  const s = String(addr ?? "").trim()
  if (!s || s.includes(":")) return false
  const parts = s.split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 地址是否像 IPv6（简化判断：含冒号且字符合法） */
export function isIpv6Loose(addr: string): boolean {
  const s = String(addr ?? "").trim()
  if (!s.includes(":")) return false
  return /^[0-9a-fA-F:]+$/.test(s) && s.split(":").length >= 2
}

/** 地址是否是合法 hosts 地址（v4 或 v6） */
export function isHostAddr(addr: string): boolean {
  return isIpv4Addr(addr) || isIpv6Loose(addr)
}

export interface FamilyCompletion {
  /** 最终要写入的地址，按 v4 在前、v6 在后 */
  addrs: string[]
  /** 补出来的屏蔽地址（用于界面提示"这一族被屏蔽了"） */
  synthesized: string[]
}

/**
 * 补齐地址族。
 *
 * 需求：只给了 v4 就把 v6 屏蔽掉，反之亦然。
 *
 * 为什么必须补而不是"少写一族就算了"：
 * hosts / mihomo hosts 只回答被显式写入的地址，未写入的那一族会回落到真实 DNS。
 * 用户之所以手填地址，往往正是因为那一族的 DNS 结果不可用（污染 / 黑洞）。
 * 不补的话，双栈客户端会从 DNS 拿到坏地址并优先尝试，表现为偶发卡顿甚至超时等待。
 * 显式写 0.0.0.0 / :: 等于告诉客户端"这一族没有可用地址"，立刻回落。
 *
 * 规则：
 *   - v4 有 → 保留全部 v4；v4 无 → 补 0.0.0.0
 *   - v6 有 → 保留全部 v6；v6 无 → 补 ::
 *   - 非法地址直接丢弃
 *   - 输出的屏蔽地址一定排在可用地址之后
 */
export function completeAddrFamilies(input: readonly string[]): FamilyCompletion {
  const v4: string[] = []
  const v6: string[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    const a = String(raw ?? "").trim()
    if (!a || !isHostAddr(a)) continue
    if (seen.has(a)) continue
    seen.add(a)
    if (isIpv4Addr(a)) v4.push(a)
    else v6.push(a)
  }

  const synthesized: string[] = []
  if (!v4.length) {
    v4.push(BLOCK_ADDR_V4)
    synthesized.push(BLOCK_ADDR_V4)
  }
  if (!v6.length) {
    v6.push(BLOCK_ADDR_V6)
    synthesized.push(BLOCK_ADDR_V6)
  }

  return { addrs: [...v4, ...v6], synthesized }
}

/** 从任意输入解析出地址数组（兼容单个字符串、逗号/空格/换行分隔） */
export function parseAddrInput(input: unknown): string[] {
  const raw: string[] = []
  const push = (x: unknown) => {
    if (x == null) return
    if (Array.isArray(x)) {
      x.forEach(push)
      return
    }
    // 一个字符串里可能塞了多个地址（逗号/空格/换行/分号分隔）
    for (const piece of String(x).split(/[,\s;]+/)) {
      if (piece) raw.push(piece)
    }
  }
  push(input)
  return raw
}

/* ------------------------------------------------------------------
 * 不可作为目标的地址
 * ------------------------------------------------------------------ */

/**
 * 「未指定地址」：0.0.0.0 与 ::。
 *
 * 为什么必须拦住：Linux 上 connect(0.0.0.0:443) 会被路由到本机，
 * 若本机恰好有服务在听，探测就会**误判为连接成功**，随后把
 * 0.0.0.0 当成「最优 IP」写进 hosts —— 等于把这个域名整段封掉。
 *
 * 实测踩过：github.io 的裸域 DNS 就返回 0.0.0.0 / ::（只有
 * user.github.io 子域提供 Pages），探测把它当可用地址，hosts 里
 * 于是出现 `0.0.0.0 github.io`；registry-1.docker.io 更糟，
 * v4 明明可用，却因 v6 候选是 :: 而被选成主地址，只输出了一条 `::`。
 */
export function isUnspecifiedAddr(addr: string): boolean {
  const s = String(addr ?? "").trim().toLowerCase()
  return s === "0.0.0.0" || s === "::" || s === "::0" || s === "0:0:0:0:0:0:0:0"
}

/** 回环地址：探测它只会测到本机，没有意义 */
export function isLoopbackAddr(addr: string): boolean {
  const s = String(addr ?? "").trim().toLowerCase()
  if (s === "::1" || s === "localhost") return true
  if (!isIpv4Addr(s)) return false
  return s.startsWith("127.")
}

/**
 * 是否是可以作为探测目标 / hosts 条目的地址。
 *
 * 排序与格式校验之外，必须排除未指定地址与回环地址：
 * 它们要么连到本机造成假成功，要么指向客户端自己，写进 hosts 只会添乱。
 */
export function isUsableTarget(addr: string): boolean {
  const s = String(addr ?? "").trim()
  if (!isHostAddr(s)) return false
  if (isUnspecifiedAddr(s)) return false
  if (isLoopbackAddr(s)) return false
  return true
}
