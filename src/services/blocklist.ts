/**
 * 自定义屏蔽清单。
 *
 * hosts 只能做「域名 → 地址」的映射，屏蔽的唯一做法是把域名指向不可用地址。
 * 关键点：**必须同时写 IPv4 与 IPv6 两条**。只写 `0.0.0.0` 时双栈机器仍会
 * 通过 AAAA 记录走 IPv6 访问；只写 `::` 时纯 IPv4 网络照样能连。两者都写，
 * 才真正堵死。
 *
 * 清单存在 KV 的 custom_blocklist 键里，与广告规则彼此独立：
 * 广告规则是上游维护的黑名单，这里是用户自己加的。
 */
import type { Bindings } from "../types"

const KV_KEY = "custom_blocklist"

export interface BlockEntry {
  domain: string
  addedAt: string
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

export async function getBlocklist(env: Bindings): Promise<BlockEntry[]> {
  try {
    const v = (await env.custom_hosts.get(KV_KEY, { type: "json" })) as BlockEntry[] | null
    if (!Array.isArray(v)) return []
    return v
      .filter((e) => e && typeof e.domain === "string" && e.domain)
      .map((e) => ({ domain: e.domain.toLowerCase(), addedAt: e.addedAt || new Date().toISOString() }))
  } catch {
    return []
  }
}

async function saveBlocklist(env: Bindings, list: BlockEntry[]): Promise<void> {
  await env.custom_hosts.put(KV_KEY, JSON.stringify(list))
}

export async function addBlocked(
  env: Bindings,
  inputs: string[]
): Promise<{ added: string[]; existed: string[]; invalid: string[] }> {
  const list = await getBlocklist(env)
  const known = new Set(list.map((e) => e.domain))
  const added: string[] = []
  const existed: string[] = []
  const invalid: string[] = []

  for (const raw of inputs) {
    const domain = normalizeDomain(raw)
    if (!domain) {
      invalid.push(String(raw).trim())
      continue
    }
    if (known.has(domain)) {
      existed.push(domain)
      continue
    }
    known.add(domain)
    added.push(domain)
    list.push({ domain, addedAt: new Date().toISOString() })
  }

  if (added.length) await saveBlocklist(env, list)
  return { added, existed, invalid }
}

export async function removeBlocked(env: Bindings, domain: string): Promise<boolean> {
  const d = normalizeDomain(domain) || domain.trim().toLowerCase()
  const list = await getBlocklist(env)
  const next = list.filter((e) => e.domain !== d)
  if (next.length === list.length) return false
  await saveBlocklist(env, next)
  return true
}

export async function clearBlocklist(env: Bindings): Promise<number> {
  const list = await getBlocklist(env)
  await saveBlocklist(env, [])
  return list.length
}
