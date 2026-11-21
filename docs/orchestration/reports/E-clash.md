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

> **未取证的一项**：`mihomo -t` 与容器内的 hosts/REJECT 断言（第 3、4 步）。
> 本机装了 Docker Desktop 但守护进程没起，我没有替你启动 GUI 应用。
> 主 agent 起 docker 后直接跑 `./scripts/verify-clash.sh` 即可补齐这两步；脚本自己会 `docker pull metacubex/mihomo:latest`、跑 `-t`、
> 起临时容器验 `/dns/query`（A + AAAA）与 REJECT 403，结束自动 `docker rm -f`。

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
