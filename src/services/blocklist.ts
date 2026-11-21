/**
 * 自定义屏蔽清单。
 *
 * hosts 只能做「域名 → 地址」的映射，屏蔽的唯一做法是把域名指向不可用地址。
 * 关键点：**必须同时写 IPv4 与 IPv6 两条**。只写 `0.0.0.0` 时双栈机器仍会
 * 通过 AAAA 记录走 IPv6 访问；只写 `::` 时纯 IPv4 网络照样能连。两者都写，
 * 才真正堵死。
 *
 * 两个来源合并输出：
 * - 内置清单（constants.ts 的 BUILTIN_BLOCKLIST）：随代码分发，始终生效，不可单独删除
 * - 用户清单（KV 的 custom_blocklist）：控制台「屏蔽网站」里自己加的
 * 与广告规则彼此独立，广告规则由上游维护。
 */
import type { Bindings } from "../types"
import { BUILTIN_BLOCKLIST } from "../constants"

const KV_KEY = "custom_blocklist"
const BUILTIN = new Set(BUILTIN_BLOCKLIST.map((d) => d.toLowerCase()))

export interface BlockEntry {
  domain: string
  addedAt: string
  /** 来自内置清单：控制台里不可单独删除 */
  builtin?: boolean
}

/**
 * 解析一行用户输入：接受网址、带端口、通配符前缀与大小写混杂的写法。
 * 返回规范化后的域名；无法识别（纯 IP、非法字符、空行）返回 null。
 */
export function normalizeDomain(input: string): string | null {
  let s = String(input || "").trim()
  if (!s || s.startsWith("#")) return null

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // 协议
  s = s.split(/[/?#]/)[0] // 路径与查询
  s = s.split("@").pop() || "" // user:pass@
  s = s.replace(/:\d+$/, "") // 端口
  s = s.replace(/^\*\./, "") // hosts 不支持通配，按主域名处理
  s = s.replace(/\.$/, "").toLowerCase()

  // 纯 IP 没有屏蔽意义（hosts 是域名映射），直接拒绝
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes(":")) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null
  if (s === "localhost" || s.endsWith(".localhost")) return null

  return s
}

async function saveBlocklist(env: Bindings, list: BlockEntry[]): Promise<void> {
  await env.custom_hosts.put(KV_KEY, JSON.stringify(list))
}

/** 内置屏蔽清单（只读） */
export function getBuiltinBlocklist(): string[] {
  return [...BUILTIN]
}

/** 用户自己加的屏蔽域名（KV），不含内置项 */
export async function getUserBlocklist(env: Bindings): Promise<BlockEntry[]> {
  try {
    const v = (await env.custom_hosts.get(KV_KEY, { type: "json" })) as BlockEntry[] | null
    if (!Array.isArray(v)) return []
    return v
      .filter((e) => e && typeof e.domain === "string" && e.domain)
      .map((e) => ({ domain: e.domain.toLowerCase(), addedAt: e.addedAt || new Date().toISOString() }))
      // 与内置清单重名的不再重复输出
      .filter((e) => !BUILTIN.has(e.domain))
  } catch {
    return []
  }
}

/** 内置 + 用户，按域名去重；hosts 输出与刷新跳过都用这份合并结果 */
export async function getBlocklist(env: Bindings): Promise<BlockEntry[]> {
  const builtin: BlockEntry[] = [...BUILTIN].map((domain) => ({ domain, addedAt: "", builtin: true }))
  return [...builtin, ...(await getUserBlocklist(env))]
}

export async function addBlocked(
  env: Bindings,
  inputs: string[]
): Promise<{ added: string[]; existed: string[]; builtin: string[]; invalid: string[] }> {
  const user = await getUserBlocklist(env)
  const known = new Set(user.map((e) => e.domain))
  const added: string[] = []
  const existed: string[] = []
  const builtin: string[] = []
  const invalid: string[] = []

  for (const raw of inputs) {
    const domain = normalizeDomain(raw)
    if (!domain) {
      invalid.push(String(raw).trim())
      continue
    }
    if (BUILTIN.has(domain)) {
      builtin.push(domain)
      continue
    }
    if (known.has(domain)) {
      existed.push(domain)
      continue
    }
    known.add(domain)
    added.push(domain)
    user.push({ domain, addedAt: new Date().toISOString() })
  }

  // 只写用户清单，内置项不能落进 KV
  if (added.length) await saveBlocklist(env, user)
  return { added, existed, builtin, invalid }
}

export async function removeBlocked(
  env: Bindings,
  domain: string
): Promise<{ ok: boolean; reason?: string }> {
  const d = normalizeDomain(domain) || domain.trim().toLowerCase()
  if (BUILTIN.has(d)) {
    return { ok: false, reason: "内置屏蔽规则不可单独取消，需要修改 src/constants.ts" }
  }
  const user = await getUserBlocklist(env)
  const next = user.filter((e) => e.domain !== d)
  if (next.length === user.length) return { ok: false, reason: "不在清单中" }
  await saveBlocklist(env, next)
  return { ok: true }
}

/** 只清用户清单；内置清单不受影响。返回值是 KV 里实际清掉的条目数 */
export async function clearBlocklist(env: Bindings): Promise<number> {
  let raw = 0
  try {
    const v = (await env.custom_hosts.get(KV_KEY, { type: "json" })) as BlockEntry[] | null
    raw = Array.isArray(v) ? v.length : 0
  } catch {
    raw = 0
  }
  await saveBlocklist(env, [])
  return raw
}
