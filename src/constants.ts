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
  "github-cloud.s3.amazonaws.com",
  "github-com.s3.amazonaws.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
  "github-production-repository-file-5c1aeb.s3.amazonaws.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
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
# 覆盖：GitHub / npm CDN / Docker Hub / Steam / 开发者资源
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
      "{{BUCKET_zhbcnz4v}}.blob.core.windows.net",
      "dl-cdn.alpinelinux.org",
      "go.dev",
      "golang.org",
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
