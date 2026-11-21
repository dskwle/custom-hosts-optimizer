# E1–E5 + E7 Clash/mihomo 规则输出

- **结论**：可合并。五个公开端点 + 一个可直接粘的片段 + 一份完整模板已就绪，`check.sh` 全绿；`/clash` 挂载行仍需主 agent 在 `server/index.ts` 加两处（挂路由 + 加入公开路径）。
- **Lane / Owner**：E / agent-E
- **分支 / 基线**：`feat/E-clash` @ `a765f37`（从 `integration/capture@a765f37` 切出）
- **状态**：REPORTED
- **报告时间**：2026-11-21 11:01

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `src/clash/yaml.ts` | +29/-0 | 新增。手写 YAML 的引号/注释/列表项工具，不引依赖 |
| `src/clash/hosts.ts` | +194/-0 | 新增。`buildClashHosts`（域名去重、v4/v6 混排、屏蔽域名剔除、脏数据丢弃）+ `formatClashHostsYaml` / `formatHostsSection` |
| `src/clash/payload.ts` | +109/-0 | 新增。`normalizeRuleDomain` / `buildDomainPayload`（去重、排序、exclude）/ `formatPayloadYaml`（空数据输出 `payload: []`） |
| `src/clash/ads.ts` | +78/-0 | 新增。`parseAdsDomains` 从 hosts 写法的 ads content 抽域名（v4/v6 两行合一条）+ `formatAdsYaml` |
| `src/clash/snippet.ts` | +220/-0 | 新增。`buildSnippetYaml`（hosts + rule-providers + rules，interval 7200）+ `buildExampleConfigYaml`（dns.use-hosts / fake-ip / tun 注释 / proxy-groups 占位） |
| `server/routes/clash.ts` | +204/-0 | 新增。`createClashRoutes(getEnv: () => Bindings): Hono`，5 个端点，`text/yaml` + `Cache-Control: public, max-age=300`，异常降级为空 YAML |
| `src/clash/hosts.test.ts` | +109/-0 | 新增。域名去重 / IPv6 混排 / 屏蔽域名不进 hosts / 脏数据 / 空输出 |
| `src/clash/payload.test.ts` | +58/-0 | 新增。大小写去重、URL 归一、通配/IP 剔除、exclude、空输出 |
| `src/clash/ads.test.ts` | +66/-0 | 新增。ads 解析去重、localhost/通配剔除、无缓存空 payload |
| `src/clash/snippet.test.ts` | +73/-0 | 新增。三段齐全、url 拼接无双斜杠、interval、策略组名替换、example 关键字段 |
| `scripts/verify-clash.sh` | +322/-0 | 新增。E7 验证：生成 fixture → YAML 结构化校验 → `mihomo -t` → 容器断言 hosts/REJECT；无 docker 打印跳过并 exit 0 |
| `tsconfig.json` | +4/-1 | 修改。加 `allowImportingTsExtensions: true`（理由见「待确认问题 1」） |

> 是否触碰非本 lane 拥有的文件：**是，仅 `tsconfig.json` 一处**。
> 原因：`scripts/check.sh` 用 `node --experimental-strip-types` 直接跑 `*.test.ts`，而 Node 的 ESM 解析要求写全扩展名（`./hosts.ts`），
> 不加 `allowImportingTsExtensions` 时 `tsc` 会报 `TS5097`。已开 `noEmit`，不影响构建产物；如主 agent 不接受，可改为
> 由主 agent 统一加，或我把测试改成"动态 import + any"的绕过写法（不推荐，测试会失去类型检查）。
> 未触碰 `server/index.ts`、`src/constants.ts`、`src/services/**`、`public/console.html`、`package.json`。

## 验收自测

```bash
$ ./scripts/check.sh
== TypeScript ==                 （0 error）
== Build (local runtime) ==
  dist-server/index.mjs  111.6kb
== Console inline JS syntax ==   （通过）
== Unit tests ==
# tests 27
# pass 27
# fail 0
全部通过

$ ./scripts/check.sh --full      # 顺带确认既有端点未受影响
/host            200
/host_fast       200
/host_block      200
/local/health    200
/                401（期望 401）
全部通过
```

`/clash` 路由在本 worktree 里尚未挂载，因此用临时探针把 `createClashRoutes` 装到一个最小 Hono 上（真实 `FileKV` + 伪造 KV/屏蔽数据），
跑完即删（按要求不留在提交里）。六个端点实测：

```bash
$ node scripts/tmp-probe-clash.mjs          # 临时脚本，验证后已删除
=== /clash/hosts.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 | 292 bytes ===
# custom-hosts 优选地址 · mihomo hosts 映射
# 域名 4 条 / 地址 4 条（v4 与 v6 混排，mihomo 按需取用）
# 数据更新时间：11/21/2026, 11:01:35
hosts:
  "api.github.com":
    - '2001:db8::10'
  "custom.example.com":
    - '203.0.113.20'
  "github.com":
    - '203.0.113.10'
  "raw.githubusercontent.com":
    - '203.0.113.11'

=== /clash/block.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 | 445 bytes ===
# custom-hosts · 屏蔽清单（内置 + 手动）
# 内置 11 条 + 手动 1 条
# 行为：命中即 REJECT；与 /clash/ads.yaml 分开，便于单独开关广告规则
# 共 12 个域名
payload:
  - 'ck.juicyads.com'
  - 'diagramjawlineunhappy.com'
  - 'gl.xlfn.live'
  - 'i.jads.co'
  - 'l.erodalabs.com'
  - 'l.qqbfw.xyz'
  - 't.nettrck.store'
  - 'tracker.example.io'
  - 'www.google-analytics.com'
  ...

=== /clash/ads.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 ===
# custom-hosts · 广告拦截域名（mihomo rule-provider payload）
# 来源：AWAvenue-Ads-Rule（上游维护，可单独开关）
# 抓取时间：11/21/2026, 11:01:35
# 上游版本：probe-1.0
# 共 1 个域名
payload:
  - 'ads.ads-example.net'          # 上游 v4/v6 两行 → 一条；与 block 重叠的 tracker.example.io 已排除

=== /clash/proxy.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 | 166 bytes ===
# custom-hosts · SNI 阻断域名（建议走代理）
# 共 1 个域名
payload:
  - 'blocked-sni.example.com'

=== /clash/snippet.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 | 1413 bytes ===
# 第 3 步里的 PROXY 必须改成你自己的策略组名；改完检查 group 名与 proxy-groups 里的一致。
# rule-providers 的 url 指向本服务（http://127.0.0.1:8892）。
hosts:
  "api.github.com":
    - '2001:db8::10'
  ...
rule-providers:
  ch-block:
    type: http
    behavior: domain
    format: yaml
    url: "http://127.0.0.1:8892/clash/block.yaml"
    path: ./ruleset/ch-block.yaml
    interval: 7200
  ...
rules:
  - RULE-SET,ch-block,REJECT
  - RULE-SET,ch-ads,REJECT
  - RULE-SET,ch-proxy,PROXY

=== /clash/config.example.yaml → 200 | text/yaml; charset=utf-8 | public, max-age=300 | 1902 bytes ===
dns:
  enable: true
  use-hosts: true
  enhanced-mode: fake-ip
...

=== 内容断言 ===
PASS  hosts 含 v4 映射
PASS  hosts 含 v6 映射
PASS  hosts 含自定义域名
PASS  hosts 剔除屏蔽域名
PASS  block 含手动屏蔽
PASS  block 含内置屏蔽
PASS  ads 只出现一次
PASS  ads 与 block 去重
PASS  proxy 含 SNI 阻断域名
PASS  snippet 三段齐全
PASS  snippet 用请求 origin 拼 url
PASS  snippet 尊重 proxy 参数
PASS  snippet interval 7200
PASS  example 含 use-hosts / fake-ip
PASS  example tun 为注释
全部通过
```

E7 验证脚本（本机 docker 守护进程未启动，走到跳过分支）：

```bash
$ ./scripts/verify-clash.sh
== 1/4 生成 YAML fixture ==
  fixture 已生成：hosts 1 条 / 地址 2 条
== 2/4 YAML 结构化校验 ==
[PASS] hosts.yaml 可解析
[PASS] hosts.yaml 是 域名→地址列表 的映射
[PASS] hosts.yaml 同时含 v4 与 v6
[PASS] hosts.yaml 不含屏蔽域名
[PASS] block.yaml 可解析且 payload 是列表
[PASS] block.yaml payload 元素均为裸域名（无地址前缀）
[PASS] ads.yaml 可解析且 payload 是列表
[PASS] ads.yaml payload 元素均为裸域名（无地址前缀）
[PASS] proxy.yaml 可解析且 payload 是列表
[PASS] proxy.yaml payload 元素均为裸域名（无地址前缀）
[PASS] snippet.yaml 可解析
[PASS] snippet.yaml 含 hosts / rule-providers / rules 三段
[PASS] snippet.yaml provider 指向本服务且 interval=7200
[PASS] snippet.yaml 的 ch-proxy 规则使用自定义策略组
[PASS] config.example.yaml 可解析
[PASS] config.example.yaml 开了 dns.enable + use-hosts
[PASS] config.example.yaml 用 fake-ip 模式
[PASS] config.example.yaml 有 proxy-groups 占位
[PASS] mihomo 验证配置可解析
== 3/4 mihomo -t 校验配置 ==
[跳过] docker 守护进程不可用，跳过 mihomo 断言（YAML 结构与单测已覆盖）
```

> **第 3、4 步当时未取证**（本机 Docker Desktop 守护进程没起）。第 1 轮返工后已补跑，见文末「harness 修复」一节。

## 契约偏差

对照 `contracts/api-capture.md` 第 4 节：

1. **`block.yaml` 的组成口径在两处文档里不一致**：第 4 节表格写「屏蔽（自定义 + 内置）」且 `ads.yaml` 是「广告规则（可单独开关）」；
   而 `multi-agent-workflow.md` 附录 A 的 E1–E3 验收标准写「block.yaml payload 条数 = 内置屏蔽 + 手动屏蔽 + 广告规则（去重后）」。
   本实现按**第 4 节表格 + 任务书 E2** 执行：`block.yaml` = 内置 + 手动；`ads.yaml` = 广告；两者用 `exclude` 去重，
   所以把两份 provider 都挂上时，总屏蔽集合仍等于附录 A 的口径（不重不漏）。如果主 agent 要求 `block.yaml` 直接合并广告，
   只需在 `server/routes/clash.ts` 的 `block.yaml` handler 里追加 ads 域名——但"广告可单独开关"的能力会随之消失。
2. 其余字段/状态码与契约一致：5 个端点全部 `200`，`content-type: text/yaml; charset=utf-8`，payload 为裸域名（`behavior: domain`）。
   额外的两个可选 query 参数（契约未禁止、不传时行为不变）：`?base=<url>` 覆盖片段里的服务地址、`?proxy=<组名>` 覆盖 `PROXY`。

## 待确认问题

1. **`tsconfig.json` 加 `allowImportingTsExtensions`**（本 lane 唯一越界修改）：是为了让 `check.sh` 里 `node --experimental-strip-types` 能跑 `.test.ts`。
   请主 agent 决定是保留（推荐，其它 lane 写纯函数测试时同样需要），还是由你统一加、我把这一行撤掉。
2. **挂载方式**：`server/index.ts` 里需要两处改动，我按要求没有动——① `root.route("/clash", createClashRoutes(() => env as any))`；
   ② `isPublicPath()` 增加 `pathname.startsWith("/clash/")`，否则会被 Basic Auth 挡成 401，与"与 /host* 同级公开"不符。
   挂载顺序建议放在 `root.get("/local/health", ...)` 之后、通配兜底 `root.all("*", ...)` 之前。
3. **`proxy.yaml` 的默认策略组名**：片段默认写 `PROXY` 并在注释里要求用户改成自己的组名；如果人类希望默认值就是某个固定组名，
   告诉我改常量即可（现在是 `snippet.ts` 的 `proxyGroup` 默认值 + `?proxy=` 可覆盖）。
4. **片段里是否要内嵌 hosts**：按任务书「含 hosts」实现，所以 snippet/config.example 会把全部优选地址带上（当前约 1.4KB，130+ 域名时约 15KB）。
   如果嫌体积大，可以改成只放 `hosts: {}` + 一句"从 /clash/hosts.yaml 复制"，但那就不再是"可直接粘"。

## 风险与回滚

- **风险 1**：`hosts.yaml` 里出现非法地址/域名会让 mihomo **整份配置加载失败**（比少几条规则严重）。已用白名单式校验拦截，并有单测覆盖；
  但 IPv6 校验是粗校验（不解析 `::` 压缩的全部规则），极端脏数据仍可能漏过——mihomo 会在 `-t` 阶段明确报错，便于定位。
- **风险 2**：`config.example.yaml` 里 `fake-ip` + `use-hosts` 同时开，某些 mihomo 版本对 `fake-ip-filter` 的处理不同，
  可能导致本地域名解析异常。模板默认不启用 TUN、`proxies: []`，用户不填节点也起得来；已按"示例"定位，不直接覆盖用户配置。
- **风险 3**：数据源（KV 为空 / ads 未抓取）时输出空结构。`payload: []` 是合法 provider，但 mihomo 对空 rule-provider 的处理因版本而异，
  最坏表现为"规则不生效"，不会崩。已在注释里写明"当前没有缓存规则，请先在控制台刷新一次"。
- **回滚**：删掉 `server/index.ts` 的两行挂载即可（端点消失，无数据迁移、无 KV 写入）。
  本 lane 不改任何持久化结构，`data/` 里的自测数据已清理。

## 合并建议

**可合并**，建议排在 A 之前（E 无依赖，且主 agent 合并后需顺手补 `server/index.ts` 的两行挂载 + `isPublicPath`）。
合并后请跑：`./scripts/check.sh && ./scripts/verify-clash.sh`（有 docker 时第 3、4 步才会真正执行）。

---

## harness 修复（第 1 轮，回应 CHANGES_REQUESTED）

主 agent 用真实产物（`/clash/snippet.yaml` + 192.168.6.5 上的服务 + http 型 provider）做了端到端验证，
证明产物本身没问题，但 **E7 脚本的两处断言写错了**——会让以后每次跑都假红。已修，并在本机真跑通了 4 步。

### P1-1 验证配置没有可用的 DNS，却用 `/dns/query` 断言

- 根因：`dns:` 段只写了 `enable: true`，没有 `listen`。mihomo 没有监听就不会起 DNS 服务，`/dns/query` 直接返回
  `{"message":"DNS section is disabled"}`。
- 修法：验证配置补 `listen: 0.0.0.0:1053` + `fake-ip` + `use-hosts`；容器发布 `1053/tcp` 与 `1053/udp`；
  断言改为 **dig 优先（`+tcp` → UDP）→ 取不到再退回 `/dns/query`**，命令与结果都打印出来（`来源：...`），一眼能看出用的哪条路。
- 为什么不是只用 dig：本机实测 mihomo 这个构建 **DoTCP 直接断连**（`communications error ... end of file`），只写 `+tcp` 会假红；
  而主 agent 那边是 UDP 被端口映射吞掉。两者都得容错，所以三路依次回退。

### P1-2 用 HTTP 状态码判 REJECT

- 根因：mihomo 的 REJECT 经 HTTP 代理返回 **502**，目标不可达也是 502，状态码根本区分不了；
  旧代码把 502 当成"REJECT 未生效"，把 502 当成"放行成功"，两条都反了。
- 修法：完全改成看 mihomo 日志的规则命中行（配置里 `log-level` 从 `warning` 提到 `info`，否则这些行根本不打印）：
  - REJECT：日志里必须出现 `--> clash-blocked.example:80` 且同行有 `RuleSet(ch-block) using REJECT`
  - 放行：`--> clash-proxy.example:80` 的行不能出现 `using REJECT`，且要命中 `RuleSet(ch-proxy)` / `using PROXY` / `dial PROXY` 之一
  - 日志异步刷盘，用轮询等待（最多 9 秒）而不是写死 `sleep`；失败时自动打印容器日志尾部 15 行
- 顺手删掉了所有 `expect 403` 的文案，避免下一个人照着改回状态码断言。

### 真跑时另外踩到的三个坑（也一并修了）

1. **`$VAR，` 在非 UTF-8 locale 下被当成变量名的一部分** → `IMAGE�: unbound variable`，
   脚本直接死在第 3 步。已把紧跟中文标点的变量全部改成 `${VAR}`。
2. **docker.io 直连超时**（`registry-1.docker.io ... context deadline exceeded`），
   会让脚本永远走"拉不到镜像跳过"。已加镜像站回退：
   `MIHOMO_IMAGE`（默认 `metacubex/mihomo:latest`）→ `MIHOMO_IMAGE_MIRROR`（默认华为 SWR 的 `docker.io/metacubex/mihomo:latest`），
   两个都拉不到才跳过，并提示可用 `MIHOMO_IMAGE=<本地镜像>` 指定。
3. **mihomo 对 AAAA 查询会先回 v4-mapped 地址**：`dig +short ... AAAA` 返回两行
   `::ffff:203.0.113.9` 与 `2001:db8::9`。旧脚本 `head -n1` 取第一条 → 永远判失败。
   现在保留全部答案再 `grep` 目标地址。这条对产品也算有用信息：hosts 里 v4/v6 混排时，
   AAAA 查询的**第一条是 `::ffff:` 形式**，客户端要取真正可用的 v6 得看后面的记录。

### 修复后完整输出（本机真跑，docker 29.9.2 + mihomo 镜像）

```bash
$ ./scripts/verify-clash.sh
== 1/4 生成 YAML fixture ==
  fixture 已生成：hosts 1 条 / 地址 2 条

== 2/4 YAML 结构化校验 ==
[PASS] hosts.yaml 可解析
[PASS] hosts.yaml 是 域名→地址列表 的映射
[PASS] hosts.yaml 同时含 v4 与 v6
[PASS] hosts.yaml 不含屏蔽域名
[PASS] block.yaml 可解析且 payload 是列表
[PASS] block.yaml payload 元素均为裸域名（无地址前缀）
[PASS] ads.yaml 可解析且 payload 是列表
[PASS] ads.yaml payload 元素均为裸域名（无地址前缀）
[PASS] proxy.yaml 可解析且 payload 是列表
[PASS] proxy.yaml payload 元素均为裸域名（无地址前缀）
[PASS] snippet.yaml 可解析
[PASS] snippet.yaml 含 hosts / rule-providers / rules 三段
[PASS] snippet.yaml provider 指向本服务且 interval=7200
[PASS] snippet.yaml 的 ch-proxy 规则使用自定义策略组
[PASS] config.example.yaml 可解析
[PASS] config.example.yaml 开了 dns.enable + use-hosts
[PASS] config.example.yaml 用 fake-ip 模式
[PASS] config.example.yaml 有 proxy-groups 占位
[PASS] mihomo 验证配置可解析

== 3/4 mihomo -t 校验配置 ==
  docker 与镜像就绪：swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/metacubex/mihomo:latest
  WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested
  time="..." level=info msg="Initial configuration complete, total time: 8ms"
  configuration file /root/.config/mihomo/config.yaml test is successful
[PASS] 配置被 mihomo 接受（hosts / rule-providers / rules 的语法与 schema 通过）

== 4/4 起容器断言 hosts 与 REJECT ==
[PASS] hosts 映射生效（A → 203.0.113.9，来源：dig @127.0.0.1:48937（tcp→udp））
[PASS] hosts 的 IPv6 映射同样生效（AAAA → 2001:db8::9，来源：dig @127.0.0.1:48937（tcp→udp））
[PASS] REJECT 规则生效（日志：clash-blocked.example:80 match RuleSet(ch-block) using REJECT）
[PASS] ch-proxy 域名走了策略组而非 REJECT（日志：clash-proxy.example:80 error: dns resolve failed: couldn't find ip）

Clash 规则输出验证通过
```

> 放行断言里出现的 `dns resolve failed` 是预期的：`clash-proxy.example` 没有 hosts 记录，
> 验证环境又不通外网 DNS，所以 mihomo 命中 `RuleSet(ch-proxy) → PROXY(DIRECT)` 后卡在解析。
> 这恰好证明**它没有被 REJECT**（否则会有 `using REJECT` 行）。

不依赖 docker 的三类分支也做了桩测试（桩掉 `docker`/`dig`/`curl`，只验脚本逻辑）：

| 场景 | 期望 | 实际 |
|---|---|---|
| REJECT 命中行存在 | exit 0 | exit 0 |
| 日志里没有 ch-block 命中行 | exit 1 + `REJECT 规则未生效` | exit 1，报错一致 |
| `ch-proxy` 被误判 REJECT | exit 1 | exit 1，报错一致 |
| dig 恒为空 | 回退 `/dns/query` 仍能判定 | PASS，来源标为 `GET /dns/query` |

`./scripts/check.sh` 复跑（本次修复只动脚本与报告，未动源码）：

```
== TypeScript ==            0 error
== Build (local runtime) == dist-server/index.mjs  111.6kb
== Console inline JS 语法 == 通过
== Unit tests ==            # tests 27 / # pass 27 / # fail 0
全部通过
```

> 环境说明：为跑这两步我启动了本机的 Docker Desktop（守护进程此前是关的），跑完没有关掉——如果 agent-A 还要用 docker 可以直接用。
