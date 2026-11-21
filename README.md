<div align="center">
  <h1>优选自定义 host · 本地运行时</h1>
  <p>自定义域名访问加速：绕开 DNS 污染，直连可用 IP。在本地 Node 环境运行，不依赖 Cloudflare Workers。</p>

  <p>
    <a href="#为什么有这个分支">为什么有这个分支</a> •
    <a href="#核心能力">核心能力</a> •
    <a href="#快速开始">快速开始</a> •
    <a href="#web-控制台">Web 控制台</a> •
    <a href="#http-接口">HTTP 接口</a> •
    <a href="#配置">配置</a> •
    <a href="#故障排查">故障排查</a>
  </p>
</div>

> 这是 `local-runtime` 分支的文档。主干 `main` 是 Cloudflare Workers 版本，两者架构不同，配置与接口不通用。

---

## 为什么有这个分支

Cloudflare Workers 有两条硬限制，直接决定了能做什么：

| 限制 | 后果 |
|---|---|
| 每请求最多 50 个 subrequest | 151 个域名要拆成 19 个分片，跨多轮才测得完 |
| cron 执行时长上限 | 分片跑不完时后半段静默丢弃，线上曾长期只有 110/151 条 |

本地运行没有这些约束，因此可以做完整探测。此外本地能拿到 Workers 拿不到的信息：

- **TLS 握手耗时**：Workers 的 `connect()` 只到 TCP 层
- **分段计时**：DNS / TCP / TLS / TTFB 四段分别计量
- **长时间采样**：分钟级持续记录延迟变化，观察劣化趋势

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **多源 DNS 交叉验证** | AliDNS + DNSPod 双源解析，比对结果发现地域性差异 |
| **候选 IP 全量测速** | 同一 IP 只测一次；IPv4 与 IPv6 合并后统一优选 |
| **TLS 硬性校验** | TCP 通了但 TLS 握不上的一律排除，避免写进 hosts 后彻底不可用 |
| **SNI 阻断归因** | 双 SNI 对照判定，区分「改 hosts 有效」与「必须走代理」 |
| **真实延迟分解** | DNS / TCP / TLS / 首字节四段独立计时 |
| **稳定性监控** | 按间隔反复采样，绘制多域名趋势曲线 |
| **服务端缓存** | 按 `IP + 域名` 缓存测量结果，全量刷新从 46s 降到 21s |
| **网络变化感知** | 出口 IP 变化时自动清空缓存，避免沿用失效数据 |
| **广告规则拼接** | 可选追加 AWAvenue-Ads-Rule 黑名单，带开关；上游只写了单族的条目自动补齐 v4/v6 |
| **Microsoft 全家桶** | 账号登录、Office 365、Outlook、Teams、Windows Update、Store、Azure、VS、Xbox 共 28 个域名 |
| **自定义屏蔽** | 批量粘贴域名，同时写 `0.0.0.0` 与 `::`，IPv4/IPv6 一起堵死 |
| **无鉴权** | 本地控制台不设任何权限校验 |

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 20**（开发时用 22.x） |
| 操作系统 | macOS / Linux / Windows |
| 磁盘 | 约 10 MB（依赖 + 数据） |

无需数据库、无需 Docker、无需 Cloudflare 账号。

运行时依赖只有两个：`hono`、`@hono/node-server`，其余走 Node 标准库（`node:net`、`node:tls`、`node:dns`）。

---

## 快速开始

```bash
npm install
npm run local
```

打开 <http://127.0.0.1:8788>，点击「开始刷新」。

命令行方式：

```bash
# 首次生成数据（232 个域名，约 60 秒）
curl -X POST http://127.0.0.1:8788/local/refresh

# 之后直接取 hosts
curl http://127.0.0.1:8788/hosts
```

> **首次必须刷新一次。** 数据来自本地探测而非回源抓取，KV 为空时 `/hosts` 只返回提示，不会自动生成。

### 可用脚本

| 命令 | 作用 |
|---|---|
| `npm run local` | 构建 + 启动 |
| `npm run local:dev` | 构建 + 启动，文件变化自动重启 |
| `npm run local:build` | 只构建，产物在 `dist-server/` |
| `npm run local:watch` | 只构建，监听源文件变化增量重建 |
| `npm run typecheck` | TypeScript 类型检查（不产出文件） |

构建走 esbuild，把 `server/index.ts` 打成单文件 ESM；`cloudflare:sockets` 在打包时映射到 `server/shims/cloudflare-sockets.ts`，业务代码无需改动。

本分支不含任何 Cloudflare 部署配置（`wrangler.toml`、CI 工作流、`.dev.vars` 均已移除），也不会误部署到线上。

### 目录结构

```
src/                 业务逻辑：路由、hosts 生成、分组常量、广告规则
server/              本地运行时：探测、缓存、任务、KV 文件实现
  shims/             cloudflare:sockets 的 Node 实现
public/console.html  单页控制台（自包含，无构建步骤）
data/                运行时数据（自动创建，已 gitignore）
dist-server/         构建产物（已 gitignore）
Dockerfile           两阶段构建：esbuild 打包 → 精简运行镜像
docker-compose.yml   应用 + 定时刷新器
```

---

## Docker 部署

NAS 或长期运行的机器上，直接用 compose 跑，无需装 Node：

```bash
docker compose up -d --build     # 首次会构建镜像（约 1~2 分钟）
docker compose logs -f app       # 看启动日志
curl http://127.0.0.1:8788/local/health
```

首次启动没有数据，`refresher` 容器会自动触发一次全量刷新（约 40~90 秒），之后每 2 小时一次。

| 项 | 说明 |
|---|---|
| 网络 | `host` 模式，直接监听宿主机端口，不做 NAT 映射；这样容器能复用宿主机的 IPv6 出口 |
| 端口 | 默认 `8788`，`APP_PORT=9000` 可改（app 与 refresher 同步生效） |
| 数据 | `./data` 挂载到 `/app/data`，删容器不丢；容器以 uid 1000 运行，宿主机目录需同 uid 可写 |
| 刷新 | `refresher` 每 7200 秒调一次 `/local/refresh?wait=true`，`REFRESH_INTERVAL` 可改 |
| IPv6 | 默认开启，优选结果会同时写 v4 与 v6 地址；宿主机无 IPv6 时设 `ENABLE_IPV6=false` 省时间 |
| npm 源 | 构建慢时加 `NPM_REGISTRY=https://registry.npmmirror.com` |

```bash
# 换端口、换 npm 源
APP_PORT=9000 NPM_REGISTRY=https://registry.npmmirror.com docker compose up -d --build

# 更新代码后重建
docker compose up -d --build

# 立即手动刷新一次
docker compose exec app curl -fsS -X POST "http://127.0.0.1:8788/local/refresh?wait=true"
```

> 容器内**没有鉴权**。`host` 模式下服务直接监听 `0.0.0.0:8788`（仅 IPv4），局域网内任何人都能打开控制台和写自定义域名；若机器有公网 IPv4 入口，请在前置反代上加认证或限制来源。刻意不绑 `::`，避免把控制台暴露到公网 IPv6。

---

## Web 控制台

首页即控制台（`/`），五个标签页。

### Hosts

按分组查看 / 复制 / 下载 hosts 内容，显示有效记录数与数据更新时间。

分组下拉可只导出部分站点：

```bash
# 只要 GitHub 的优选条目，不含广告规则
curl "http://127.0.0.1:8788/hosts?group=github&ads=false"
```

注意 `?group=` 只过滤优选区，广告规则（若已启用）仍会追加在末尾。需要纯净的单组输出时加上 `&ads=false`。

### 延迟诊断

- **单域名模式**：四段耗时分解 + SNI 阻断判定；判定无阻断时同样自动加入自定义域名（「对比全部候选」模式亦然）
- **对比全部候选**：列出所有候选 IP 的 TCP / TLS / 成功率，标出被排除的地址及原因
- **批量模式**：一次粘贴多行域名（可直接贴网址，自动去掉协议与路径），并发 3 个逐个探测；
  结果按失败置顶排列，判定无 SNI 阻断的域名连同实测最优 IP 一起自动写入自定义域名，随即出现在 hosts 输出里

### 批量刷新

- 分组刷新、并发可选（8 / 16 / 24）
- 实时进度条与失败计数
- 结果表**失败项置顶**，点击任意行展开完整详情（候选 IP、各 DoH 返回、SNI 结论）
- 广告规则开关与缓存管理

### 稳定性监控

选定分组与采样间隔（30s / 1min / 5min），持续记录延迟并绘制趋势曲线，用于发现「什么时候开始变慢」。

### 自定义域名

批量粘贴添加自有域名，它们会一并出现在 hosts 输出中。

已经被内置规则覆盖的域名（例如 `github.com`）、或已经在列表里的域名，添加时会直接提示「已在内置加速列表「GitHub」」/「已在自定义域名中」，不会产生重复条目；测速后自动加入的路径也走同一套判断。

添加走的是本地探测（AliDNS + DNSPod + 真实 TLS 握手），不是 Cloudflare / Google DoH——后者在国内不可达，会让绝大多数域名直接报「无法解析」。

每个标签右侧的 **⇄** 可以把这条配置一键转到「屏蔽网站」：配错边的时候（本该加速却加进了屏蔽，或反之）不必手动删了再加。

### 屏蔽网站

批量粘贴要屏蔽的域名（可直接贴网址，自动去协议与路径），每行一个。

写入 hosts 时每条域名固定输出两行：

```
0.0.0.0   example.com
::        example.com
```

**只写一族没有意义**——只写 `0.0.0.0` 时，双栈机器仍会通过 AAAA 记录走 IPv6 访问；只写 `::` 时纯 IPv4 网络照样能连。两族都写才真正堵死。

被屏蔽的域名会同时从优选区、广告区、`/hosts.json` 和批量刷新中剔除，避免出现「屏蔽了但 v4 优选地址先生效」这种自相矛盾的结果。AWAvenue 规则里只写单族的条目也会自动补齐另一族。

列表里只显示手动添加的部分；内置规则的数量在上方提示里给出，不混在一起（避免误以为可以删除）。

每个标签右侧的 **⇄** 把该域名转回「自定义域名」：会自动重新探测一次，拿到最优 IP 再写入；如果域名属于内置屏蔽规则，会明确拒绝（这类只能改代码）。

清单分两个来源，合并输出：

| 来源 | 存放位置 | 能否删除 |
|---|---|---|
| 内置规则 | `src/constants.ts` 的 `BUILTIN_BLOCKLIST` | 控制台标「内置」，不可单独删除，只能改代码 |
| 自己添加 | KV `custom_blocklist` | 标签上的 × 随时取消，或「清空全部」 |

### 域名查询

看清某个域名到底落在哪条规则里，支持三种匹配方式：

| 方式 | 写法示例 | 命中 |
|---|---|---|
| 包含匹配 | `github` | github.com、api.github.com、gist.github.com … |
| 正则匹配 | `^api\..*\.com$` | api.github.com、api.deepl.com … |
| 占位符匹配 | `*.github.com`、`cdn.*.net` | 前缀/后缀任意，`*` 任意串、`?` 单字符；不写通配符时等同包含匹配 |

举个例子：

```
github   → github.com / api.github.com / gist.github.com …（内置加速）
bump     → katabump.com / control.katabump.com …（内置加速）
```

四个分类可以单独勾选：**内置加速**（`SITE_GROUPS`）、**内置屏蔽**（`BUILTIN_BLOCKLIST`）、
**手动加速**（自定义域名）、**手动屏蔽**（自己加的屏蔽）。结果会标出所属分组、指向的 IP 与添加时间，精确命中排在最前。

结果最右一列「操作」对**手动**条目提供一键对调（`改为屏蔽` / `改为加速`），配错了原地纠正即可；内置规则那两列显示 `—`。

---

## 工作方式

单个域名的探测流程：

```
DNS 解析（AliDNS + DNSPod，A + AAAA）
   ↓ 合并去重（同一 IP 只测一次）
缓存命中？ ── 是 ──→ 直接复用（TTL 2 小时）
   ↓ 否
TCP 443 握手 —— 失败则淘汰
   ↓ 成功
TLS 握手（真实 SNI）—— 失败则排除，不写入 hosts
   ↓ 成功
按 TCP 延迟排序，取最优
   ↓
SNI 阻断归因（仅诊断时）
```

### 三层过滤

1. **TCP 可达**：连不上直接淘汰
2. **TLS 可握手**：TCP 通但握手被重置的，一律排除
3. **SNI 未阻断**：判定为 SNI 阻断的域名自动加入排除清单，后续刷新跳过

第 2 层是必须的。实测遇到过 TCP 96ms（比最优 IP 还快）但 TLS 阶段 `ECONNRESET` 的地址——只看 TCP 延迟会选中它，写进 hosts 后该域名反而打不开。

### 关于 SNI 阻断

判定方式是**双 SNI 对照**：对同一 IP 用真实域名握手一次，再用无关域名做对照。

| 真实 SNI | 对照 SNI | 判定 | 对 hosts 的意义 |
|---|---|---|---|
| 成功 | — | `ok` | 有效 |
| 失败 | 成功 | `sni-blocked` | **无效，必须走代理** |
| 失败 | 失败（TCP 通） | `unknown` | 无法归因，结果不可采信 |
| — | — | `tcp-blocked` | IP 层封锁 |

之所以要对照，是因为 TLS 失败原因很多（证书不匹配、限流、协议版本），单次失败无法归因。

---

## HTTP 接口

### 数据输出

| 接口 | 说明 |
|---|---|
| `GET /host` | **全部**：优选区 + 广告规则 + 自定义屏蔽（`/hosts` 同义） |
| `GET /host_fast` | **仅加速**：只有优选区，不含广告与屏蔽段 |
| `GET /host_block` | **仅屏蔽**：广告规则 + 自定义屏蔽，每条域名 v4/v6 各一行 |
| `GET /hosts.json` | 结构化 JSON，含分组归类（已剔除屏蔽域名） |

三个文本接口都支持 `?group=` 过滤分组；`/host` 与 `/host_block` 支持 `?ads=false` 临时去掉广告规则。

数据时间戳取自实际刷新时间，重复请求不会变化，可用于 diff 判断数据是否真的更新。

### 刷新与探测

| 接口 | 说明 |
|---|---|
| `POST /local/refresh` | 异步刷新，返回 `taskId`。`?wait=true` 同步等待 |
| `GET /local/tasks/:id` | 任务进度 |
| `GET /local/probe?domain=x` | 单域名完整探测 |
| `GET /local/timing?domain=x` | 四段延迟分解（可带 `?ip=`） |
| `GET /local/compare?domain=x&rounds=3` | 候选 IP 多轮对比 |
| `GET /local/sni?domain=x` | 仅做 SNI 阻断判定 |
| `POST /local/adopt` | 把 `{items:[{domain,ip}]}` 写成自定义域名（用实测 IP，不再重新解析）；已内置/已存在/已屏蔽的会跳过并说明原因 |
| `GET /local/lookup?q=&cats=&mode=` | 查询域名属于哪个规则；`cats` 取 `builtin-accel,builtin-block,custom-accel,custom-block`，`mode` 取 `contains`（默认）/ `regex` / `glob` |
| `GET /local/blocklist` | 只返回手动添加的屏蔽项，另附 `builtinCount` 内置规则数量 |

刷新参数：

| 参数 | 作用 |
|---|---|
| `group=github,npm` | 只刷指定分组 |
| `concurrency=8` | 并发数，默认 8 |
| `noCache=true` | 忽略缓存强制重测 |
| `includeBlocked=true` | 连已判定的阻断域名一起测 |

### 状态与管理

| 接口 | 说明 |
|---|---|
| `GET /local/groups` | 分组与域名数 |
| `GET /local/cache` · `POST /local/cache/clear` | IP 缓存状态 / 清空 |
| `GET /local/blocked` · `DELETE /local/blocked/:domain` | 阻断清单 / 解除 |
| `POST /local/blocked/recheck` | 重新检测全部阻断域名 |
| `GET /local/ads` · `POST /local/ads` | 广告规则状态 / 开关 |
| `POST /local/ads/refresh` | 重新抓取广告规则 |
| `GET /local/doh` · `POST /local/doh/reset` | DoH 可达性 / 重置熔断 |
| `GET /local/network` | 当前出口 IP 与变化判断 |
| `POST /local/monitor/start` · `stop` · `GET status` | 监控控制 |
| `GET /local/series?group=x` | 趋势数据 |
| `GET /local/health` | 存活检查 |

### 自定义域名

`GET /api/custom-domains`、`POST /api/custom-domains`（单个或 `batch` 批量）、`DELETE /api/custom-domains/:domain`。

---

## 配置

全部通过环境变量，均可省略：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8788` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。默认仅本机，外部访问改 `0.0.0.0` |
| `ENABLE_IPV6` | 开启 | `false` 退回纯 IPv4，可省约 30% 刷新时间 |
| `ENABLE_INTL_DOH` | 关闭 | `true` 启用 Cloudflare / Google DoH（国内不可达） |

```bash
PORT=9000 ENABLE_IPV6=false npm run local
```

### 网络依赖

**必需**：

| 目标 | 用途 | 实测延迟 |
|---|---|---|
| `dns.alidns.com` | DNS 主源 | 33 ms |
| `doh.pub` | DNS 备源 | 162 ms |

**可选**（失败不影响主流程）：

| 目标 | 用途 | 失败表现 |
|---|---|---|
| `gcore.jsdelivr.net` | 广告规则 | 保留上一份规则 |
| `ipinfo.io` → `myip.ipip.net` | 网络变化检测 | 跳过判断，不清缓存 |

---

## 数据目录

`data/` 首次运行自动创建，已加入 `.gitignore`：

```
data/
├── kv/
│   ├── domain_data.json       域名优选结果（核心）
│   ├── ads_rules_v2.json      广告规则缓存（每条域名 v4+v6）
│   ├── ads_config.json        广告开关
│   └── custom_blocklist.json  自定义屏蔽清单
├── ip-cache.json             IP 延迟缓存（TTL 2 小时）
├── blocked-domains.json      SNI 阻断排除清单
└── network-identity.json     出口 IP 基线
```

均为纯 JSON 文件，可直接查看或手工修正。删掉即可恢复初始状态。

---

## 域名分组

232 个域名分 15 组，定义在 `src/constants.ts` 的 `SITE_GROUPS`：

| 分组 | 数量 | 覆盖 |
|---|---|---|
| `github` | 35 | GitHub 主站、Raw、头像、Actions、Release |
| `game` | 29 | Rockstar、Epic、Battle.net、EA、Ubisoft、Riot |
| `dev` | 22 | PyPI、Maven、Go、Rust、Conda、VS Code |
| `web` | 23 | 必应、微软账户、Edge、DeepL、验证码、网盘、短链、IP 检测 |
| `microsoft` | 28 | 微软主站、账号、Office 365、Outlook、Teams、Windows Update、Store、Azure、VS、Xbox |
| `netflix` | 13 | 主站、播放 API、资源 CDN、fast.com 测速 |
| `steam` | 11 | 商店、社区、CDN 静态资源 |
| `docker` | 7 | 镜像拉取、认证、Layer 下载 |
| `cloudflare` | 12 | 官方主站、开发者文档、Workers、Pages、Turnstile 验证码 |
| `npm` | 6 | npm registry、jsDelivr、unpkg、esm.sh |
| `cdn` | 20 | Google Fonts、cdnjs、jQuery、BootCDN、字节/七牛 staticfile、饿了么 npm 镜像 |
| `mod` | 6 | Nexusmods、CurseForge、Thunderstore |
| `anime` | 8 | 番剧站、影视数据库、资源站 |
| `adult` | 6 | 成人站 |
| `intl` | 7 | Stack Overflow、Python、Node.js、KataBump 面板 |

新增站点前建议先用 `/local/probe` 确认无 SNI 阻断——阻断的域名加进去也不会生效。

---

## 性能参考

本机实测（联通，151 个域名的阶段）：

| 场景 | 耗时 |
|---|---|
| 全量刷新，无缓存 | 46 秒 |
| 全量刷新，缓存已满 | 21 秒 |
| 单组刷新（6 个域名），命中缓存 | 0.8 秒 |
| 单域名探测 | 1~2 秒 |

缓存命中率约 88%，未命中的多是 anycast 域名——它们每轮返回的 IP 会变。

---

## 已知限制

**IPv6 依赖网络环境。** 部分网络会「有地址但不出网」。此时 IPv6 候选因超时被自动淘汰，不影响 IPv4 使用，只是多等一次超时。

**缓存覆盖不到延迟劣化。** 出口 IP 不变时缓存继续生效，但同一 IP 在 24 秒内延迟就可能波动 12~30%（晚高峰、路由调整、CDN 重调度都不改出口 IP）。TTL 2 小时是权衡结果。

**SNI 阻断会变化。** 判定结果随网络策略调整，建议定期用「重新检测全部」复核。实测曾出现 12 个里有 4 个其实已恢复。

**域名列表需手工维护。** 写入 `src/constants.ts`。

**`dash.cloudflare.com` 这类地址会变。** Cloudflare 控制面板入口是随机生成的，失效后需替换为当前地址。

---

## 故障排查

**`/hosts` 返回「尚未生成数据」**

KV 为空，执行一次刷新：

```bash
curl -X POST http://127.0.0.1:8788/local/refresh
```

**刷新很慢**

- 首次无缓存属正常（约 40~46 秒）
- 若长期很慢，检查 `ENABLE_IPV6` 是否开着而网络实际不通 IPv6
- 并发过高会因连接数限制产生伪失败，建议保持 8

**某个域名一直失败**

```bash
curl "http://127.0.0.1:8788/local/probe?domain=example.com"
```

看 `sni.verdict`：

- `sni-blocked` / `tcp-blocked` → 改 hosts 无效，需代理
- `unknown` → 检测条件不可靠（对照组也失败），稍后重测

**缓存似乎没生效**

```bash
curl http://127.0.0.1:8788/local/cache
curl http://127.0.0.1:8788/local/network   # 看是否因换网被清空
```

**DoH 一直超时**

国际 DoH 在国内不可达属正常，默认已关闭。需要时：

```bash
ENABLE_INTL_DOH=true npm run local
```

---

## 项目来源

本项目在以下开源项目基础上改造：

- [GitHub520](https://github.com/521xueweihan/GitHub520) — GitHub 访问加速
- [github-hosts](https://github.com/TinsFox/github-hosts) — hosts 文件生成

广告拦截规则来自 [AWAvenue-Ads-Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule)。

## 开源许可

[MIT](./LICENSE)
