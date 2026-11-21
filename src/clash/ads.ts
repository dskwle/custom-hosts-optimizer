/**
 * 广告规则 → clash ads.yaml。
 *
 * `services/ads.ts` 缓存的内容是 hosts 写法：每个域名固定两行
 * （`0.0.0.0 d` 与 `:: d`）。mihomo 的 domain 型 provider 只要域名，
 * 所以这里从文本里把域名抽出来、去重（v4/v6 两行会落到同一个域名上）、
 * 再交给 payload 生成器。
 *
 * 注意：adblock 上游偶尔会有 `*.xxx.com` 或 `_service._tcp` 之类的写法，
 * 这些在 `behavior: domain` 下不合法，统一丢弃（normalizeRuleDomain 负责判定）。
 */
import { buildDomainPayload, formatPayloadYaml, normalizeRuleDomain } from "./payload.ts"

/**
 * 从 hosts 写法的规则文本里抽出域名列表（已去重、已排序）。
 *
 * 兼容三种行：
 * - `0.0.0.0 d` / `:: d`（本项目缓存格式，两列）
 * - 单列裸域名（上游若改成纯域名列表，不用改代码）
 * - `#` / `!` 注释、空行（跳过）
 */
export function parseAdsDomains(content: string): string[] {
  const set = new Set<string>()

  for (const line of String(content ?? "").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#") || t.startsWith("!")) continue

    const parts = t.split(/\s+/)
    // 两列时取第二列（地址在第一列）；一列时当裸域名处理
    const candidate = parts.length >= 2 ? parts[1] : parts[0]
    // 上游的通配写法（`*.xxx` / `*xxx`）语义不统一，不猜——
    // 猜错会把不该拦的拦掉，代价远大于少拦一条广告域名。
    if (!candidate || candidate.includes("*")) continue
    const domain = normalizeRuleDomain(candidate)
    if (domain) set.add(domain)
  }

  return [...set].sort()
}

export interface AdsPayloadOptions {
  /** 抓取时间（ISO），仅写进注释 */
  fetchedAt?: string | null
  /** 上游声明的版本号，仅写进注释 */
  version?: string | null
  /** 与主屏蔽清单重复的域名由调用方通过 exclude 传入 */
  exclude?: Iterable<string>
}

/** 生成 `/clash/ads.yaml`。content 为空时输出合法的空 payload */
export function formatAdsYaml(
  content: string | null | undefined,
  options: AdsPayloadOptions = {}
): { yaml: string; count: number } {
  const parsed = parseAdsDomains(content ?? "")
  const payload = buildDomainPayload(parsed, { exclude: options.exclude })

  const notes: string[] = ["来源：AWAvenue-Ads-Rule（上游维护，可单独开关）"]
  if (options.fetchedAt) {
    const d = new Date(options.fetchedAt)
    if (!Number.isNaN(d.getTime())) {
      notes.push(
        `抓取时间：${d.toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })}`
      )
    }
  }
  if (options.version) notes.push(`上游版本：${options.version}`)
  if (!content) notes.push("当前没有缓存规则，请先在控制台刷新一次")

  const yaml = formatPayloadYaml(payload.domains, {
    title: "custom-hosts · 广告拦截域名（mihomo rule-provider payload）",
    notes,
    // 只统计「写法非法」的条数；与屏蔽清单重复的不算，避免注释误导
    skippedCount: payload.skipped.length,
  })
  return { yaml, count: payload.domains.length }
}
