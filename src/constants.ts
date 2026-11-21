export const GITHUB_URLS = [
  "alive.github.com",
  "api.github.com",
  "assets-cdn.github.com",
  "avatars.githubusercontent.com",
  "avatars0.githubusercontent.com",
  "avatars1.githubusercontent.com",
  "avatars2.githubusercontent.com",
  "avatars3.githubusercontent.com",
  "avatars4.githubusercontent.com",
  "avatars5.githubusercontent.com",
  "camo.githubusercontent.com",
  "central.github.com",
  "cloud.githubusercontent.com",
  "codeload.github.com",
  "collector.github.com",
  "desktop.githubusercontent.com",
  "favicons.githubusercontent.com",
  "gist.github.com",
  "github.blog",
  "github.com",
  "github.community",
  "github.githubassets.com",
  "github.global.ssl.fastly.net",
  "github.io",
  "github.map.fastly.net",
  "githubstatus.com",
  "live.github.com",
  "media.githubusercontent.com",
  "objects.githubusercontent.com",
  "pipelines.actions.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
  "vscode.dev",
  "education.github.com",
  "private-user-images.githubusercontent.com",
]

export const HOSTS_TEMPLATE = `# custom-hosts 自动生成
# 覆盖：{groups}
# 原理：绕开 DNS 污染，直连可用 IP

{content}

# 数据更新时间：{updateTime}
`

export interface SiteGroup {
  id: string
  name: string
  description: string
  domains: string[]
}

// 站点分组。新增站点只需往对应组的 domains 里加域名，
// 判定标准：DNS 解析被污染/劣化，但真实 IP 本身可连通。
// 若站点是 TLS SNI 阻断（如 Google、YouTube），加 hosts 无效，不要放进来。
export const SITE_GROUPS: SiteGroup[] = [
  {
    id: "github",
    name: "GitHub",
    description: "代码托管、Raw 文件、头像、Actions、Release 下载",
    domains: GITHUB_URLS,
  },
  {
    id: "npm",
    name: "npm / 前端 CDN",
    description: "npm registry、jsDelivr、unpkg、esm.sh",
    domains: [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "cdn.jsdelivr.net",
      "fastly.jsdelivr.net",
      "unpkg.com",
      "esm.sh",
    ],
  },
  {
    id: "docker",
    name: "Docker Hub",
    description: "镜像拉取、认证、Layer 下载",
    domains: [
      "registry-1.docker.io",
      "auth.docker.io",
      "index.docker.io",
      "hub.docker.com",
      "registry.docker.io",
      "production.cloudflare.docker.com",
      "download.docker.com",
    ],
  },
  {
    id: "steam",
    name: "Steam",
    description: "商店、社区、CDN 静态资源",
    domains: [
      "store.steampowered.com",
      "api.steampowered.com",
      "steamcommunity.com",
      "store.steamstatic.com",
      "cdn.akamai.steamstatic.com",
      "cdn.cloudflare.steamstatic.com",
      "community.cloudflare.steamstatic.com",
      "avatars.steamstatic.com",
      "steamcdn-a.akamaihd.net",
      "steamcommunity-a.akamaihd.net",
      "media.steampowered.com",
    ],
  },
  {
    id: "game",
    name: "游戏平台",
    description: "Rockstar、Epic、Battle.net、EA、Ubisoft、Riot",
    domains: [
      "socialclub.rockstargames.com",
      "www.rockstargames.com",
      "rgl.rockstargames.com",
      "gamedownloads.rockstargames.com",
      "store.epicgames.com",
      "www.epicgames.com",
      "battle.net",
      "us.battle.net",
      "www.ea.com",
      "ubisoft.com",
      "www.riotgames.com",
      "valorant.com",
      "gog.com",
      "www.gog.com",
      "api.gog.com",
      "images.gog.com",
      "epicgames.com",
      "api.epicgames.dev",
      "www.minecraft.net",
      "api.minecraftservices.com",
      "launchermeta.mojang.com",
      "piston-data.mojang.com",
      "libraries.minecraft.net",
      "resources.download.minecraft.net",
      "bungie.net",
      "www.bungie.net",
      "api.warframe.com",
      "content.warframe.com",
      "osu.ppy.sh",
    ],
  },
  {
    id: "mod",
    name: "游戏模组",
    description: "Nexusmods、CurseForge、Thunderstore",
    domains: [
      "www.nexusmods.com",
      "staticdelivery.nexusmods.com",
      "www.curseforge.com",
      "media.forgecdn.net",
      "edge.forgecdn.net",
      "thunderstore.io",
    ],
  },
  {
    id: "web",
    name: "网页工具",
    description: "必应、微软账户、Edge、DeepL、验证码、网盘、短链、IP 检测",
    domains: [
      "www.bing.com",
      "login.live.com",
      "microsoftedge.microsoft.com",
      "api.deepl.com",
      "hcaptcha.com",
      "assets.hcaptcha.com",
      "steamdb.info",
      "op.gg",
      "tracker.gg",
      "pcgamingwiki.com",
      "howlongtobeat.com",
      "sourceforge.net",
      "pan.baidu.com",
      "api.bilibili.com",
      "hanime1.me",
      "www.mediafire.com",
      "gofile.io",
      "ouo.io",
      "dnstest.dev",
      "docs.wushuo.top",
      "cdn.staticstack.net",
      "ippure.com",
      "www.ippure.com",
    ],
  },
  {
    id: "microsoft",
    name: "Microsoft",
    description: "微软主站、账号登录、Office 365、Outlook、Teams、Windows Update、Store、Azure、VS、Xbox",
    domains: [
      "www.microsoft.com",
      "login.microsoftonline.com",
      "login.microsoft.com",
      "account.microsoft.com",
      "go.microsoft.com",
      "support.microsoft.com",
      "learn.microsoft.com",
      "download.microsoft.com",
      "www.office.com",
      "outlook.office.com",
      "outlook.live.com",
      "teams.microsoft.com",
      "graph.microsoft.com",
      "update.microsoft.com",
      "download.windowsupdate.com",
      "apps.microsoft.com",
      "storeedgefd.dsx.mp.microsoft.com",
      "displaycatalog.mp.microsoft.com",
      "shell.cdn.office.net",
      "nuget.org",
      "api.nuget.org",
      "portal.azure.com",
      "dev.azure.com",
      "code.visualstudio.com",
      "visualstudio.microsoft.com",
      "download.visualstudio.microsoft.com",
      "www.xbox.com",
      "assets1.xboxlive.com",
    ],
  },
  {
    id: "netflix",
    name: "Netflix",
    description: "主站、播放 API、登录、资源 CDN、官方测速站 fast.com",
    domains: [
      "netflix.com",
      "www.netflix.com",
      "api-global.netflix.com",
      "ichnaea.netflix.com",
      "ichnaea-web.netflix.com",
      "appboot.netflix.com",
      "help.netflix.com",
      "media.netflix.com",
      "assets.nflxext.com",
      "codex.nflxext.com",
      "fast.com",
      "www.fast.com",
      "api.fast.com",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "官方主站、开发者文档、博客、Workers、Pages、Turnstile 验证码",
    domains: [
      "cloudflare.com",
      "www.cloudflare.com",
      "developers.cloudflare.com",
      "blog.cloudflare.com",
      "workers.cloudflare.com",
      "pages.dev",
      // Turnstile 验证码与其挑战页分片，登录/注册页常用
      "challenges.cloudflare.com",
      "hagen.challenges.cloudflare.com",
      "brunhild.challenges.cloudflare.com",
      "ca1.cloudflarecaptcha.com",
      "ca2.cloudflarecaptcha.com",
      // Cloudflare 控制面板入口。该域名长度随机、.mbf 无公开 NS 记录，
      // 是 CF 有意采用的特殊用途地址，避免面板入口被批量猜中。
      // 注意：地址可能随时间变化，失效后需替换为当前实际地址。
      "dash.cloudflare.com",
    ],
  },
  {
    id: "intl",
    name: "国外常用",
    description: "开发者社区、Python、Node.js、KataBump 面板",
    domains: [
      "stackoverflow.com",
      "www.python.org",
      "nodejs.org",
      "katabump.com",
      "www.katabump.com",
      "dashboard.katabump.com",
    ],
  },
  {
    id: "anime",
    name: "动漫影视",
    description: "番剧站、影视数据库、追番记录、资源站",
    domains: [
      "animes.garden",
      "mikanime.tv",
      "tmdb.org",
      "themoviedb.org",
      "anilist.co",
      "sorafolder.com",
      "cossora.stream",
      "hls-cdn.cossora.stream",
    ],
  },
  {
    id: "adult",
    name: "其他站点",
    description: "成人站点",
    domains: [
      "youjizz.com",
      "cosplaytele.com",
      "theporndude.com",
      "18av.mm-cg.com",
      "javbooks.com",
      "vdownload.hembed.com",
    ],
  },
  {
    id: "dev",
    name: "开发者资源",
    description: "PyPI、Maven、Go、Rust、Conda、VS Code",
    domains: [
      "pypi.org",
      "files.pythonhosted.org",
      "repo1.maven.org",
      "repo.maven.apache.org",
      "proxy.golang.org",
      "sum.golang.org",
      "crates.io",
      "static.crates.io",
      "index.crates.io",
      "rubygems.org",
      "repo.anaconda.com",
      "conda.anaconda.org",
      "update.code.visualstudio.com",
      "marketplace.visualstudio.com",
      "dl-cdn.alpinelinux.org",
      "go.dev",
      "golang.org",
      "nodejs.org",
      "static.rust-lang.org",
      "plugins.jetbrains.com",
      "dl.google.com",
      "storage.googleapis.com",
    ],
  },
]

// 所有分组的域名合集（去重）
export const ALL_DOMAINS: string[] = [...new Set(SITE_GROUPS.flatMap((g) => g.domains))]

// 按 ?group=github,npm 解析出要输出的域名清单；无参数或全部非法时返回全量
export function resolveGroupDomains(param?: string | null): string[] {
  if (!param) return ALL_DOMAINS
  const ids = param
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const picked = new Set<string>()
  for (const id of ids) {
    const group = SITE_GROUPS.find((g) => g.id === id)
    if (group) group.domains.forEach((d) => picked.add(d))
  }

  return picked.size > 0 ? [...picked] : ALL_DOMAINS
}

export const GITHUB_API_BASE = "https://api.github.com"

export const HOSTS_PATH = "hosts"

interface DNSProvider {
  name: string
  url: (domain: string) => string
  headers: Record<string, string>
  type: "dns-json" | "html"
}

export const DNS_PROVIDERS: DNSProvider[] = [
  {
    name: "Cloudflare DNS",
    url: (domain: string) => `https://1.1.1.1/dns-query?name=${domain}&type=A`,
    headers: { Accept: "application/dns-json" },
    type: "dns-json"
  },
  {
    name: "Google DNS", 
    url: (domain: string) => `https://dns.google/resolve?name=${domain}&type=A`,
    headers: { Accept: "application/dns-json" },
    type: "dns-json"
  },
  {
    name: "IPAddress.com",
    url: (domain: string) => `https://sites.ipaddress.com/${domain}`,
    headers: { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    },
    type: "html"
  }
]

/**
 * 内置屏蔽清单：随代码分发的黑名单，始终生效，控制台里不可单独删除。
 *
 * 都是实测确认的广告/追踪域名（用户反馈后固化），
 * 与用户自己在「屏蔽网站」里加的清单合并输出，每条同样写 v4 + v6 两行。
 */
export const BUILTIN_BLOCKLIST: string[] = [
  "www.google-analytics.com",
  "i.jads.co",
  "ck.juicyads.com",
  "l.erodalabs.com",
  "gl.xlfn.live",
  "l.qqbfw.xyz",
  "t.nettrck.store",
  "zesty-career.com",
  "diagramjawlineunhappy.com",
  "www.ourdreamersai13.com",
  "xn--the-realcomeandgo98-4704at12mxyjkj2es34dy15b.rqjc37.cyou",
]
