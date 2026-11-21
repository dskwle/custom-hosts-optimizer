/**
 * 广告拦截规则（AWAvenue-Ads-Rule）。
 *
 * 用途：把第三方维护的广告域名黑名单拼接到生成的 hosts 末尾，
 * 每轮批量刷新时抓取一次，平时直接读缓存。
 *
 * 两个必须注意的点：
 *
 * 1. 必须剔除 localhost 相关条目。
 *    上游文件里有 `127.0.0.1 localhost` 与 `::1 localhost`。
 *    若原样拼接，虽然值恰好相同，但一旦上游改动写成 `0.0.0.0 localhost`，
 *    就会把本机 localhost 解析成不可用的地址，导致一堆本地服务连不上。
 *    这类风险不值得承担，直接过滤。
 *
 * 2. 上游注释用 `!` 开头（AdGuard 语法），不是 hosts 的 `#`。
 *    原样保留会让 hosts 文件出现无法解析的行，因此统一转成 `#`。
 *
 * 抓取失败时保留上一次的有效规则，不清空——广告规则过期一天远比没有要好。
 */
import type { Bindings } from "../types"

const SOURCE_URL =
  "https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/Filters/AWAvenue-Ads-Rule-hosts.txt"

/** KV 中的存储键。v2：内容改为「每条域名固定 v4+v6 两行」，旧缓存不再兼容 */
const KV_KEY = "ads_rules_v2"
/** 启用开关的存储键 */
const KV_CONFIG_KEY = "ads_config"

export interface AdsConfig {
  enabled: boolean
}

export interface AdsRulesMeta {
  /** 抓取时间（ISO） */
  fetchedAt: string
  /** 有效规则行数 */
  ruleCount: number
  /** 上游声明的版本号，便于判断是否更新 */
  version?: string
  /** 上游声明的更新时间 */
  upstreamUpdatedAt?: string
  /** 规则内容（已清洗） */
  content: string
}

/** 抓取并清洗规则。返回清洗后的文本与统计。 */
export async function fetchAdsRules(
  timeoutMs = 15000
): Promise<{ content: string; ruleCount: number; version?: string; upstreamUpdatedAt?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let raw = ""
  try {
    const res = await fetch(SOURCE_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    raw = await res.text()
  } finally {
    clearTimeout(timer)
  }

  const lines = raw.split(/\r?\n/)
  let version: string | undefined
  let upstreamUpdatedAt: string | undefined
  const domainSet = new Set<string>()

  for (const line of lines) {
    const t = line.trim()
    if (!t) continue

    // AdGuard 注释 -> hosts 注释
    if (t.startsWith("!")) {
      const v = t.match(/^!Version:\s*(.+)$/i)
      if (v) version = v[1].trim()
      const u = t.match(/^!Update time:\s*(.+)$/i)
      if (u) upstreamUpdatedAt = u[1].trim()
      continue
    }

    // 只接受「地址 + 域名」两列结构
    const parts = t.split(/\s+/)
    if (parts.length < 2) continue
    const domain = parts[1].toLowerCase()

    // 安全阀：hosts 文件里的 localhost 永远不该被这条规则覆盖
    if (/(^|\.)localhost$/i.test(domain) || domain === "localhost.localdomain") continue
    // 也跳过整体为空的域名
    if (!domain || !domain.includes(".")) continue
    // 跳过明显是通配或非法字符的行
    if (/[*?\[\]{}]/.test(domain)) continue
    // 只保留域名：上游 IPv4 / IPv6 行会落到同一个域名上，下面统一补齐
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(":")) continue

    domainSet.add(domain)
  }

  // 上游有相当一部分条目只写了 v4（0.0.0.0）或只写了 v6（::）。
  // 只拦一侧等于没拦：双栈机器换另一族地址就绕过去了，所以固定补成两条。
  const rules: string[] = []
  for (const domain of [...domainSet].sort()) {
    rules.push(`0.0.0.0 ${domain}`)
    rules.push(`:: ${domain}`)
  }

  return {
    content: rules.join("\n"),
    // 统计口径是「域名数」，每条域名实际会输出两行（v4 + v6）
    ruleCount: domainSet.size,
    version,
    upstreamUpdatedAt,
  }
}

/** 读取缓存的规则；没有则返回 null */
export async function getAdsRules(env: Bindings): Promise<AdsRulesMeta | null> {
  try {
    const v = (await env.custom_hosts.get(KV_KEY, { type: "json" })) as AdsRulesMeta | null
    return v && typeof v.content === "string" ? v : null
  } catch {
    return null
  }
}

/**
 * 是否启用广告规则。默认启用——用户主动要求拼接，首次即生效更符合预期。
 * 显式关闭后，刷新时不再抓取，hosts 输出也不追加。
 */
export async function getAdsEnabled(env: Bindings): Promise<boolean> {
  try {
    const v = (await env.custom_hosts.get(KV_CONFIG_KEY, { type: "json" })) as AdsConfig | null
    return v?.enabled !== false
  } catch {
    return true
  }
}

export async function setAdsEnabled(env: Bindings, enabled: boolean): Promise<boolean> {
  try {
    const cfg: AdsConfig = { enabled }
    await env.custom_hosts.put(KV_CONFIG_KEY, JSON.stringify(cfg))
    return true
  } catch (err) {
    console.error("[ads] 保存开关失败", (err as Error).message)
    return false
  }
}

/**
 * 抓取并写入 KV。抓取失败时保留旧数据并返回失败原因，
 * 由调用方决定是否提示。
 */
export async function refreshAdsRules(
  env: Bindings
): Promise<{ ok: boolean; meta?: AdsRulesMeta; error?: string }> {
  try {
    const r = await fetchAdsRules()
    if (r.ruleCount === 0) {
      return { ok: false, error: "抓取成功但未解析出有效规则" }
    }
    const meta: AdsRulesMeta = {
      fetchedAt: new Date().toISOString(),
      ruleCount: r.ruleCount,
      version: r.version,
      upstreamUpdatedAt: r.upstreamUpdatedAt,
      content: r.content,
    }
    await env.custom_hosts.put(KV_KEY, JSON.stringify(meta))
    console.log(`[ads] 已更新广告规则：${r.ruleCount} 条，版本 ${r.version ?? "未知"}`)
    return { ok: true, meta }
  } catch (err) {
    const msg = (err as Error).message
    console.warn(`[ads] 抓取失败，保留旧规则：${msg}`)
    return { ok: false, error: msg }
  }
}
