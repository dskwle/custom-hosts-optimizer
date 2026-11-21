/**
 * rule-provider payload 生成（`behavior: domain`）。
 *
 * 契约里的 block.yaml / ads.yaml / proxy.yaml 都是同一个形状：
 * `payload:` 下面一串纯域名，不带 `0.0.0.0` 前缀。原因：`behavior: domain`
 * 的 providers 只认域名，混入 IP 或通配会整份 provider 加载失败；
 * 需要混合类型时 mihomo 才要求 `behavior: classical` 并加前缀。
 *
 * 因此这里做两件事：把各种来源的写法规范化成域名，并把非法项统计出来
 * （统计只进注释，不进 payload——注释数量是排查"为什么这条没生效"的唯一线索）。
 */
import { isIpAddress } from "./hosts.ts"
import { comment, listItem } from "./yaml.ts"

/**
 * 规范化一个「规则用域名」。
 *
 * 比 hosts 的 normalizeHostDomain 宽松：允许带协议、路径、端口、
 * 前导 `*.` 的输入（控制台里用户可能整段粘贴 URL），
 * 但输出永远是裸域名；含通配符残留或非法字符的直接判 null。
 */
export function normalizeRuleDomain(raw: string): string | null {
  let s = String(raw ?? "").trim()
  if (!s || s.startsWith("#") || s.startsWith("!")) return null

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  s = s.split(/[/?#]/)[0]
  s = s.replace(/^[^@]*@/, "") // user:pass@
  s = s.replace(/:\d+$/, "")
  s = s.replace(/^\*\./, "") // `*.example.com` 在 behavior: domain 下等价于 example.com
  s = s.replace(/\.$/, "").toLowerCase()

  if (!s || s.length > 253) return null
  // 纯 IP 在 domain 型 provider 里没有意义；通配/空格/下划线一律不要，避免 provider 加载失败
  if (isIpAddress(s)) return null
  if (/[*?[\]{}_\s]/.test(s)) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null
  return s
}

export interface DomainPayload {
  domains: string[]
  /** 被丢弃的原始输入，便于在注释里说明 */
  skipped: string[]
}

/**
 * 批量规范化并去重。
 *
 * - 去重不区分大小写（统一小写后再比）
 * - 排序：输出稳定，provider 每次拉取的内容不变，mihomo 不必重载
 * - exclude：把已被主屏蔽清单覆盖的域名剔掉，避免 ads 与 block 两份 provider 重复
 */
export function buildDomainPayload(
  domains: Iterable<string>,
  options: { exclude?: Iterable<string> } = {}
): DomainPayload {
  const exclude = new Set<string>()
  for (const d of options.exclude ?? []) {
    const n = normalizeRuleDomain(d)
    if (n) exclude.add(n)
  }

  const set = new Set<string>()
  const skipped: string[] = []

  for (const raw of domains) {
    const n = normalizeRuleDomain(raw)
    if (!n) {
      const text = String(raw ?? "").trim()
      if (text) skipped.push(text)
      continue
    }
    if (exclude.has(n)) continue
    set.add(n)
  }

  return { domains: [...set].sort(), skipped }
}

export interface FormatPayloadOptions {
  /** 注释标题 */
  title?: string
  /** 额外的说明行（例如数据来源、抓取时间） */
  notes?: string[]
  /** 被丢弃的条数；>0 时在注释里提示 */
  skippedCount?: number
}

/**
 * 输出 payload YAML。空数据输出 `payload: []`，
 * 让 mihomo 能正常加载（空 provider 合法），也方便前端判断"当前没有规则"。
 */
export function formatPayloadYaml(
  domains: readonly string[],
  options: FormatPayloadOptions = {}
): string {
  const head: string[] = [options.title ?? "mihomo rule-provider payload（behavior: domain）"]
  for (const n of options.notes ?? []) if (n) head.push(n)
  head.push(`共 ${domains.length} 个域名`)
  if (options.skippedCount && options.skippedCount > 0) {
    head.push(`已跳过 ${options.skippedCount} 条非法/重复写法（IP、通配符、空行等）`)
  }

  if (!domains.length) return `${comment(head)}\npayload: []\n`

  const lines = domains.map((d) => listItem(d, 2))
  return `${comment(head)}\npayload:\n${lines.join("\n")}\n`
}
