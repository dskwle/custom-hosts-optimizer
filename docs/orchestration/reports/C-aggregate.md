# C1–C5 抓包聚合与建议（Lane C）

- **结论**：可合并——纯函数层跑通，`./scripts/check.sh` 全绿，36 个单测全部通过；有两个契约层面的边界问题需要主 agent 拍板（见「待确认问题」1、2）。
- **Lane / Owner**：C / agent-C
- **分支 / 基线**：`feat/C-aggregate` @ `a765f37`（从 `integration/capture@a765f37` 切出；当前 `integration/capture` 已前进到 `f156f1c`，本 lane 未 rebase）
- **状态**：REPORTED
- **报告时间**：2026-11-21 11:20

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `server/capture/types.ts` | +57/-0 | 新增。按契约 §1 逐字落地的类型定义（仓库里原本没有该文件，B 也需要它） |
| `server/capture/aggregate.ts` | +231/-0 | 新增。按 host 聚合 + 判定谓词 + 第一方/第三方 |
| `server/capture/advice.ts` | +126/-0 | 新增。规则矩阵 + `summarize()` 组合入口 |
| `server/capture/aggregate.test.ts` | +194/-0 | 新增。聚合/谓词/后缀/排序 17 例 |
| `server/capture/advice.test.ts` | +154/-0 | 新增。规则矩阵 13 例 |
| `server/capture/fixtures.test.ts` | +108/-0 | 新增。三个 fixture 的端到端断言 6 例 |
| `server/capture/fixtures/normal-site.json` | +15/-0 | 新增。正常站（对照组，零建议） |
| `server/capture/fixtures/news-ads.json` | +20/-0 | 新增。广告多的资讯站（`example.co.uk` 多级后缀） |
| `server/capture/fixtures/video-site.json` | +16/-0 | 新增。视频站（媒体 CDN + 第一方流地址） |
| `docs/orchestration/reports/C-aggregate.md` | +本文件 | 报告 |

> 是否触碰非本 lane 拥有的文件：**否**。未改 `public/console.html`、`server/index.ts`、`src/**`、`package.json`、`scripts/check.sh`。
> 注：`git add -A` 会把 `node_modules` 符号链接带进提交（`.gitignore` 里的 `node_modules/` 匹配不到符号链接），因此本次按文件显式 `git add`，没有用 `-A`。

## 验收自测

### 1. 质量门禁

```bash
$ ./scripts/check.sh
== TypeScript ==
（0 error）
== Build (local runtime) ==
  dist-server/index.mjs  111.6kb
⚡ Done in 20ms
== Console inline JS syntax ==
script[0] 语法 OK（1328 行）
== Unit tests ==
1..36
# tests 36
# suites 0
# pass 36
# fail 0
# cancelled 0
# skipped 0
# todo 0

全部通过
$ echo $?
0
```

### 2. 单测覆盖的场景（36 例）

| 场景 | 用例数 | 断言要点 |
|---|---|---|
| 空输入 | 1 | `aggregate([])` → `[]` |
| 全缓存 | 2 | 计入 `requests`，`p50/p95Ttfb/p95Total` 均为 `undefined`，`bytes` 仍累计 |
| p95 / p50 | 1 | 最近秩法：10 条 100…1000ms → p95=1000、p50=550；单条样本返回该值 |
| >5s 与边界 | 1 | `5000` 不算慢、`5001` 算慢；`slowMs` 可覆盖 |
| 超时 | 1 | `ERR_TIMED_OUT` / `ERR_CONNECTION_{RESET,REFUSED,ABORTED}` / `ERR_NAME_NOT_RESOLVED` / `ERR_EMPTY_RESPONSE` 命中；`ERR_CERT_*` 不命中 |
| 第一方慢 / 第一方失败 | 2 | `ignore` + `suggested=false` + reason 含「改 hosts 可能无解」 |
| 多级后缀 | 2 | `news.example.co.uk` → `example.co.uk`；`co.uk`/`com.cn`/`com.au`/`co.jp`/`github.io`/IP/单段主机 |
| SNI 阻断覆盖 | 2 | 单元用例 + 视频站整站 9 个域名全部 `proxy`、`suggested` 全 false |
| 其他 | 24 | 主机归一化（大小写/端口/尾部点/IPv6）、kinds 去重排序、排序口径、`suggested` 只对 block/accel、`summarize` 不改入参 |

### 3. 三个 fixture 的建议分布（实际输出）

```bash
$ node --experimental-strip-types /tmp/dist.mts     # summarize(fixture.requests, {pageHost})
```

**normal-site.json**（pageHost=example.org，6 个域名，suggested=0）

```
verdicts: {"unknown":6}
unknown  www.googletagmanager.com  req=1 p95ttfb=420  p95 首字节 0.4s，未见异常
unknown  static.example.org        req=2 p95ttfb=320
unknown  cdn.jsdelivr.net          req=3（含 2 条缓存）
unknown  example.org               req=1 p95ttfb=180
unknown  api.example.org           req=2
unknown  fonts.gstatic.com         req=1
```

**news-ads.json**（pageHost=news.example.co.uk，12 个域名，suggested=7）

```
verdicts: {"accel":5,"block":2,"ignore":1,"unknown":4}
accel ✔ ads.doubleclick.net            p95ttfb=8400  第三方脚本 p95 8.6s，超过 5s
accel ✔ widgets.outbrain.com           p95ttfb=7200  第三方脚本 p95 9.1s，超过 5s
accel ✔ cdn.taboola.com                p95ttfb=6300  第三方脚本 p95 6.7s，超过 5s
accel ✔ pagead2.googlesyndication.com  p95ttfb=6100  第三方脚本 p95 6.4s，超过 5s
accel ✔ cdn.ads-network.co.uk          p95ttfb=5400  第三方图片 p95 5.6s，超过 5s（多级后缀判定生效）
block ✔ tracker.adnetwork.com          fail=1 ERR_TIMED_OUT
block ✔ analytics.segment.io           fail=1 ERR_CONNECTION_RESET
ignore  cdn.example.co.uk              p95ttfb=6200  第一方 p95 6.4s 偏慢，改 hosts 可能无解
unknown news.example.co.uk / static.example.co.uk / www.googletagmanager.com / ssl.gstatic.com(缓存)
```

**video-site.json**（pageHost=video.example.com，9 个域名，suggested=2）

```
verdicts: {"accel":2,"ignore":2,"unknown":5}
accel ✔ player.vimeo.com    p95ttfb=6100/total 9800  第三方脚本 p95 9.8s，超过 5s
accel ✔ cdn.video-cdn.net   req=3 p95ttfb=5200       第三方媒体 p95 5.6s，超过 5s
ignore  stream.example.com  p95ttfb=8200  第一方 p95 8.4s 偏慢，改 hosts 可能无解
ignore  api.example.com     fail=1 ERR_NAME_NOT_RESOLVED  第一方失败，需排查源站
unknown video.example.com / thumbnails.example.com / static.example.com / i.ytimg.com(缓存) / player.example.com(缓存)
+ ctx.sniBlocked=true 时：9 个域名全部 proxy，suggested 全 false
```

## 实现要点（供 B / D 对接）

```ts
// B 侧 /summary 建议直接用这个入口，避免拿到 verdict 全 unknown 的裸聚合结果
import { summarize } from './capture/advice.ts'
const hosts = summarize(requests, { pageHost, sniBlocked })   // HostSummary[]，字段与契约 §1 一致
```

- `aggregate(requests, pageHost?)`：纯聚合，`verdict='unknown'`、`reason=''`、`suggested=false` 占位；`pageHost` 缺省时取首个 `document` 请求的 host。
- `advise(summary, ctx)`：`ctx = { pageHost?, sniBlocked?, slowMs? }`，返回 `{verdict, reason, suggested}`，不修改入参。
- 阈值：`SLOW_MS`（默认 5000）可由 `CAPTURE_SLOW_MS` 环境变量覆盖；`advise` 还支持 `ctx.slowMs` 做单次覆盖（测试与 F2 调参）。
- 参与率：`suggested` 仅 `block` / `accel` 为 `true`，第一方一律 `false`（避免「全选」把正常域名塞进 hosts）。
- 排序：p95 TTFB（退化到 p95 总耗时）降序 → 请求数降序 → 域名升序。

## 契约偏差

无字段或结构偏差。三处实现约定需要备案：

1. `aggregate` 增加**可选**第二参数 `pageHost`（缺省从 document 推断）——契约只规定返回结构，签名未冻结，不影响 `HostSummary` 字段。
2. `HostSummary` 里没有超时计数，`TIMEOUT` 判定以谓词 `isTimeout(req)` 导出，聚合阶段不使用（见待确认问题 2）。
3. `bytes` 累计包含缓存命中请求（缓存资源仍代表真实体积）；若 D 想展示「实际传输量」，需另加字段。

## 待确认问题

1. **tsconfig 需一行开关**：`import ... from './aggregate.ts'`（`node --experimental-strip-types` 只认显式后缀）会被 tsc 报 `TS5097`，而根 `tsconfig.json` 未开 `allowImportingTsExtensions`，且该文件不归本 lane。当前用 5 处 `// @ts-ignore TS5097` 带注释绕过（`advice.ts` 1 处 + 3 个测试文件 4 处）。建议主 agent 在 `tsconfig.json` 的 `compilerOptions` 加 `"allowImportingTsExtensions": true`，之后这些注释可删除（保留也无害）。E lane 写 `.test.ts` 时会踩同一个坑。
2. **`HostSummary` 承载不了超时信息**：契约字段里没有 `timeouts`，所以 block 的 reason 只能写「N 个请求中 M 个失败」，无法区分「超时」和「证书错误」。若产品希望文案体现超时，需要在契约 §1 加 `timeouts: number`（C 侧改动约 3 行，D 侧加一列）。**本 lane 未擅自加字段。**
3. **第一方失败的 verdict**：当前判 `ignore`（reason「需排查源站」），而不是 `unknown`。理由是「用户看得到原因，但工具确实无能为力」。如果 D 的表格只有 block/accel 两档操作，`ignore` 与 `unknown` 展示上无差别。
4. **`ctx.sniBlocked` 是整站级的布尔**，不是逐域名判定。B 侧要拿什么作为依据（内置 SNI 阻断清单命中？抓包时探测？）需要主 agent 统一口径；当前 C 侧只做「一旦为真则全部 proxy」。
5. **建议参与率**：news-ads fixture 12 个域名里 7 个被勾选（58%）。这个站点广告确实重，但若真实站点出现「勾选 >60%」的情况，D 可能需要二次确认弹层。
6. 排序口径：当前按「最慢优先」。如果 D 的默认列头是「域名」或「请求数」，需要 D 侧自行重排，C 侧不做 UI 相关妥协。

## 风险与回滚

- 风险：多级后缀表是手写白名单（40 条），未收录的后缀会退化为「末两段」——例如 `example.co.zz` 会被判成 `co.zz`，进而把同后缀的不同站点误判为第一方（漏报，不会误伤）。这是刻意选择：宁可漏报 block，也不误伤正常域名。
- 风险：`suggested=true` 的 block 会直接写进 `/host_block`，误伤代价高；当前只有「第三方 + 确实有失败」才会 block，正常站 fixture 为 0 建议。
- 回滚：`server/capture/{aggregate,advice}.ts` 是新增文件，删除即恢复；`types.ts` 被 B 引用，删除前需确认 B 是否已合并自己的版本。

## 合并建议

可合并，建议顺序在 B 之后（B 的 `/summary` 直接 import `summarize`），但对 A/E 无依赖，也可先合。合并时请注意 `server/capture/types.ts` 与 B 的同名文件冲突——两边内容都应是契约 §1 的逐字复制，若冲突请以契约原文为准。
