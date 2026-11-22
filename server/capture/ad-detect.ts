/**
 * 抓包里的广告 / 追踪识别（纯函数，零 IO）。
 *
 * 为什么不能只看「第三方 + 慢」：那套规则是为了判断"该不该加速"，
 * 与"这是不是广告"完全是两件事。一个第三方慢接口可能是正常的 API，
 * 而一个响应极快的 img 请求可能就是广告像素。
 *
 * 判定分三档，只有前两档才建议屏蔽：
 *
 *   high   —— 命中已启用的广告规则清单（AWAvenue 那 1900+ 条）。
 *             这是最强证据：清单本身是人工维护的实测结果。
 *   medium —— 域名命名带明确的广告/追踪词（ads. / adserver. / doubleclick
 *             这类），或「追踪类词 + 第三方」双重命中。
 *   low    —— 只有 URL 路径特征（/banner、/pixel.gif 等）。
 *             路径太容易误伤（站点自己的广告位、A/B 实验），不建议据此屏蔽。
 *
 * 误判代价不对称：漏掉一个广告只是多看一眼，错杀一个资源会让页面坏掉。
 * 所以门槛刻意偏高，且每条结论都带可读依据，让用户能自己复核。
 */

/** 明确表示"广告位"的域名片段，单凭它就足够判 medium */
const AD_WORDS = [
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'adservice',
  'adserver',
  'adnxs',
  'adsystem',
  'advertising',
  'adcolony',
  'applovin',
  'unityads',
  'vungle',
  'chartboost',
  'inmobi',
  'moatads',
  'taboola',
  'outbrain',
  'criteo',
  'pubmatic',
  'rubiconproject',
  'openx',
  'smartadserver',
  'yieldmo',
  'sharethrough',
]

/**
 * 明确的广告 / 追踪服务商域名（后缀匹配）。
 *
 * 为什么需要这份内置表：AWAvenue 那套规则以国内广告为主，
 * 实测 google-analytics / doubleclick 有收录，但 googletagmanager、
 * clarity.ms、scorecardresearch 都缺——而它们恰恰是最常见的追踪脚本。
 * 只靠清单会大量漏判。
 *
 * 用精确后缀而不是 includes 关键词，是为了避免误伤：
 * `segment` 会撞上 segmentfault.com，`clarity` 也可能撞上同名品牌。
 */
const TRACKER_VENDORS = [
  'googletagmanager.com',
  'googletagservices.com',
  'google-analytics.com',
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'clarity.ms',
  'hotjar.com',
  'hotjar.io',
  'mixpanel.com',
  'amplitude.com',
  'segment.io',
  'segment.com',
  'scorecardresearch.com',
  'quantserve.com',
  'comscore.com',
  'connect.facebook.net',
  'facebook.net',
  'bat.bing.com',
  'clarity.microsoft.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'ads.tiktok.com',
  'analytics.tiktok.com',
  'static.ads-twitter.com',
  'analytics.twitter.com',
]

/** 追踪/分析类词：单独出现不够，需配合第三方身份 */
const TRACK_WORDS = [
  'analytics',
  'tracking',
  'tracker',
  'telemetry',
  'beacon',
  'pixel',
  'metrics',
  'statistics',
  'adtrack',
]

/** 子域前缀：ads. / ad. / track. 这类，语义最直接 */
const AD_SUBDOMAIN_PREFIX = /^(ads?|adserv\w*|track\w*|pixel|beacon|telemetry|analytics|metrics|stats?)\./i

/** URL 路径特征：只作为 low 档的辅助证据 */
const AD_PATH = /(^|\/)(ads?|adserver|advert\w*|banners?|popunder|prebid|pagead|track(ing)?|pixel|beacon|analytics)(\/|\.|$)/i

export type AdSignalStrength = 'high' | 'medium' | 'low'

export interface AdVerdict {
  /** 是否建议屏蔽（high / medium 才为 true） */
  isAd: boolean
  strength: AdSignalStrength | null
  /** 命中的依据，中文，可直接展示；未命中为空数组 */
  signals: string[]
}

export interface AdDetectInput {
  host: string
  /** 请求路径，可选（未开 storeUrls 时没有） */
  url?: string
  /** 是否为第三方域名（相对页面主机） */
  thirdParty: boolean
  /** 已启用的广告规则域名集合（小写） */
  knownAds?: ReadonlySet<string>
}

/** 后缀匹配：`ssl.1rtb.com` 命中 `1rtb.com`，但 `not1rtb.com` 不命中 */
export function hostMatchesSuffix(host: string, suffix: string): boolean {
  const h = host.toLowerCase()
  const s = suffix.toLowerCase()
  if (!h || !s) return false
  return h === s || h.endsWith(`.${s}`)
}

function hitKnownAd(host: string, knownAds?: ReadonlySet<string>): string | null {
  if (!knownAds?.size) return null
  // 先精确命中（绝大多数情况），没有再逐个后缀比对
  if (knownAds.has(host)) return host
  for (const rule of knownAds) {
    if (hostMatchesSuffix(host, rule)) return rule
  }
  return null
}

function pathOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).pathname + new URL(url).search
  } catch {
    return ''
  }
}

/**
 * 判定一个域名是否为广告 / 追踪。
 *
 * @returns isAd 为 true 时才有 strength；signals 始终给出人话依据
 */
export function detectAd(input: AdDetectInput): AdVerdict {
  const host = (input.host || '').toLowerCase().trim()
  if (!host) return { isAd: false, strength: null, signals: [] }

  const signals: string[] = []

  // ---- high：命中已启用的广告清单 ----
  const known = hitKnownAd(host, input.knownAds)
  if (known) {
    signals.push(`命中已启用的广告规则（${known}）`)
    return { isAd: true, strength: 'high', signals }
  }

  // ---- 内置服务商表兜底：清单更新滞后，常见追踪脚本常被漏掉 ----
  const vendor = TRACKER_VENDORS.find((v) => hostMatchesSuffix(host, v))
  if (vendor) {
    const isAdNetwork = /doubleclick|googlesyndication|googleadservices|\.ads\.|adserver/.test(vendor)
    signals.push(
      isAdNetwork
        ? `属于已知广告网络（${vendor}）`
        : `属于已知追踪/分析服务商（${vendor}）`,
    )
    return { isAd: true, strength: 'high', signals }
  }

  // ---- medium：域名本身带明确广告词 ----
  const adWord = AD_WORDS.find((w) => host.includes(w))
  if (adWord) {
    signals.push(`域名含广告服务商标识（${adWord}）`)
    return { isAd: true, strength: 'medium', signals }
  }

  const prefix = host.match(AD_SUBDOMAIN_PREFIX)
  if (prefix) {
    // ads./adserver. 这类前缀语义明确；analytics./stats. 需要第三方身份佐证，
    // 否则会把站点自己的统计子域也判成广告
    const strongPrefix = /^(ads?|adserv\w*)\./i.test(host)
    if (strongPrefix) {
      signals.push(`子域前缀为广告用途（${prefix[1]}）`)
      return { isAd: true, strength: 'medium', signals }
    }
    if (input.thirdParty) {
      signals.push(`第三方域名的追踪类子域（${prefix[1]}）`)
      return { isAd: true, strength: 'medium', signals }
    }
  }

  // ---- medium：追踪词 + 第三方 ----
  const trackWord = TRACK_WORDS.find((w) => host.includes(w))
  if (trackWord && input.thirdParty) {
    signals.push(`第三方域名含追踪类词（${trackWord}）`)
    // 再叠一条路径特征会更稳，但单凭"第三方 + 追踪词"已经够可读了
    return { isAd: true, strength: 'medium', signals }
  }

  // ---- low：只有路径特征，不据此屏蔽 ----
  const path = pathOf(input.url)
  if (path && AD_PATH.test(path)) {
    const m = path.match(AD_PATH)
    signals.push(`URL 路径含广告特征（${m?.[1] ?? 'ad'}）`)
    return { isAd: false, strength: 'low', signals }
  }

  return { isAd: false, strength: null, signals: [] }
}
