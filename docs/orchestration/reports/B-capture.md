# T0-1 抓包后端（Lane B）

- **结论**：可合并（新增 7 个端点，契约零字段偏差；仅剩主 agent 的挂载行与 NAS 真实环境验收）
- **Lane / Owner**：B / agent-B
- **分支 / 基线**：`feat/B-capture` @ `713ecfd`（从 `integration/capture@9a3796d` 切出）
- **状态**：REPORTED
- **报告时间**：2026-11-21 11:29

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `server/capture/cdp.ts` | +695/-0 | 新增。极简 CDP 客户端（WebSocket JSON-RPC、id 配对、超时、断线回调）+ `/json/*` HTTP helpers + 事件→`CapturedRequest` 纯函数与 `RequestTracker` |
| `server/capture/session.ts` | +495/-0 | 新增。`CaptureManager`：单会话约束、开/停、断线重连、自动停止、聚合 `/summary` |
| `server/capture/store.ts` | +105/-0 | 新增。`data/capture/<id>.json` 原子落盘，保留最近 20 个 |
| `server/capture/stream.ts` | +68/-0 | 新增。SSE 扇出 hub（state/request/error/end 四帧） |
| `server/routes/capture.ts` | +314/-0 | 新增。`createCaptureRoutes(getEnv, getCdpUrl)`，除 `/env` 外的 7 个端点 + `shutdownCaptureSessions()` |
| `server/capture/cdp-pure.test.ts` | +312/-0 | 新增。19 个单测：类型映射、host 提取、TTFB/总耗时口径、缓存判定、重定向、断线换代、sweep |
| `scripts/orch/capture-selftest.mjs` | +469/-0 | 新增。本机 headless 浏览器端到端自测（含错误码模式、标签页不误伤断言） |
| `docs/orchestration/reports/B-capture.md` | + 本文件 | 新增 |

> 是否触碰非本 lane 拥有的文件：**否**。`server/index.ts`、`public/console.html`、`src/**`、`package.json` 一行未动（`git status` 只有 7 个新文件）。
> `cdp-pure.test.ts` 与 C 的 `*.test.ts` 不冲突：C 的 aggregate/advice 测试未改动，这个文件只测 `cdp.ts`。

## 验收自测

```bash
$ ./scripts/check.sh
exit=0
== TypeScript ==
== Build (local runtime) ==
== Console inline JS syntax ==
== Unit tests ==
# tests 87
# pass 87
# fail 0
全部通过
```

单元测试（本 lane 的 19 条）：

```bash
$ node --experimental-strip-types --test server/capture/cdp-pure.test.ts
1..19
# pass 19
# fail 0
```

端到端（本机 headless Edge/Chromium，`--launch` 自带浏览器；脚本用内存 KV 起一个最小服务，不碰真实 `data/kv`）：

```bash
$ node scripts/orch/capture-selftest.mjs --launch --url https://github.com --wait 5000

== 开始抓包：https://github.com ==
· 模拟用户标签页：9A8EF64A49B969B275C8DB571008960E
✓ start → capture-1795231761813-f2d1b7（status=running）
✓ 重复 start → 409
· 等页面加载 5000ms …

== 汇总 ==
✓ summary 返回 5 个域名、共 100 条请求
✓ 域名数 ≥ 1
✓ 域名数 ≤ 200（量级与 DevTools 一致）

  top5 慢域名（p95）：
    images.ctfassets.net               请求 4   p95 ttfb    255ms p95 total   1364ms verdict=unknown 第三方
    github.githubassets.com            请求 91  p95 ttfb    349ms p95 total   1330ms verdict=unknown 第三方
    videos.ctfassets.net               请求 1   p95 ttfb    221ms p95 total   1287ms verdict=unknown 第三方
    collector.github.com               请求 2   p95 ttfb    315ms p95 total    980ms verdict=unknown
    github.com                         请求 2   p95 ttfb    138ms p95 total    424ms verdict=unknown
· verdict 分布：{"unknown":5}

== 详情与停止 ==
✓ 详情返回 100 条请求（session.requestCount=100）
✓ 请求明细 ≥ 1
✓ 隐私默认：未存 url
✓ stop → status=stopped
✓ 重复 stop 幂等

== 标签页清理（不误伤用户其它标签页） ==
✓ 用户已有标签页仍在（没被误关）
✓ 抓包标签页已关闭（page 数 3 → 3）

== SSE 帧 ==
· 收到帧：{"state":2,"request":100,"end":1}
✓ 有 state 帧
✓ 有 request 帧
✓ 有 end 帧
✓ end 帧后保持约 5s 再关（5001ms）

== SSE 重连到已结束的会话 ==
✓ 重连先补一帧 state
✓ 重连收到 end 帧
✓ 重连后立即关闭（3ms）

== 列表与落盘 ==
✓ 列表包含本次会话
✓ 已落盘 data/capture/capture-1795231761813-f2d1b7.json（100 条）

== apply（block，仅写内存 KV） ==
✓ block → added 含目标域名
✓ 重复 block → skipped 已屏蔽

  自测摘要：
    会话       capture-1795231761813-f2d1b7
    请求总数   100
    域名数     5
    等待时长   5000ms
    总耗时     5331ms（start → stop）

自测通过
```

**实测数据**：`github.com` → 5 个域名 / 100 条请求 / 5.3s；`www.debian.org` → 1 个域名 / 25 条请求 / 4.3s（debian 首页资源全在同一域名，量级与 DevTools Network 面板一致）。

错误码分支（CDP 指向死端口）：

```bash
$ node scripts/orch/capture-selftest.mjs --cdp http://127.0.0.1:9 --only-errors
✓ 空 url → 400
✓ 非 http(s) → 400
✓ 未知会话 → 404
✓ 停止未知会话 → 404
✓ apply 空 hosts → 400
✓ CDP 不可达 → 502 且文案与契约一致
```

SNI 标记（临时写入 `data/blocked-domains.json`，测完已删）：

```text
github.githubassets.com  请求 90  p95 ttfb 197ms  p95 total 371ms  verdict=proxy 第三方
· verdict 分布：{"unknown":4,"proxy":1}
```

断线分支（抓包中途 kill 浏览器，模拟容器重启）：

```text
start: capture-...-caa462 running
杀浏览器（模拟容器重启）
final: failed CDP 连接断开（重连失败：CDP WebSocket 已断开） requests= 25
SSE 帧类型: {"state":2,"request":22,"error":1,"end":1}
error 帧: {"type":"error","message":"CDP 连接断开（重连失败：CDP WebSocket 已断开）"}
```

## 契约偏差

无字段/结构/错误码偏差（`/start` `/` `/:id` `/:id/summary` `/:id/stop` `/:id/stream` `/apply` 的形状与 `contracts/api-capture.md` 逐字一致；409/502/404 的文案用的契约原文）。以下是契约未规定、由实现补充的行为，需主 agent 确认：

1. **`apply` 单次上限 50 个域名**（超出返回 400「单次最多 50 个域名，请分批提交」）。原因：每个 accel 域名都要现场 `probeDomain`（DNS+TCP+多次 TLS，秒级），50 个在 4 并发下已要十几秒；静默截断会让用户以为全处理了。
2. **会话自动停止**：`CAPTURE_MAX_MS`（默认 180s）。用户点了开始就关页面是常态，没有这条会一直占着浏览器窗口。
3. **`cached` 额外接受 `Network.requestServedFromCache`**：契约只写了 `fromDiskCache`/`fromMemoryCache`，但 `setCacheDisabled(true)` 之后这两者很少出现，该事件是同一语义的补充信号（仍不给 ttfb/total）。
4. **`/local/capture/`（带尾斜杠）返回 404**：Hono 路由的默认行为，契约路径本身不带尾斜杠（`/?limit=20`）。前端按 `API + '/local/capture?limit=20'` 调用即可。
5. **`skipped[].reason` 文案统一为 `内置加速` / `已在自定义域名` / `已屏蔽`**（按主 agent 在前端合并时的要求）：block 方向的内置项也报「已屏蔽」，不自创「内置屏蔽」。前端按关键字（内置/屏蔽/存在）映射标签，三处保持一致。
6. **`GET /local/capture` 返回 `{sessions: []}`**（契约形状），不迁就前端的裸数组兜底。

## 待确认问题

1. **挂载行**（必须由主 agent 加，本 lane 不能改 `server/index.ts`）：

   ```ts
   import { createCaptureRoutes, shutdownCaptureSessions } from "./routes/capture.js"
   // 必须放在鉴权中间件之后（与 /env 的挂载同级）
   root.route("/local/capture", createCaptureRoutes(() => env as any, () => resolveCdpUrl()))
   ```

   同一路径已有 `createCaptureEnvRoutes` 的挂载，Hono 允许多次 `route()` 挂到同一前缀（子路径不冲突即可），所以**不需要**合并两次调用。

2. **可选一行**：`process.on('SIGINT', ...)` 里调 `shutdownCaptureSessions()`。不接也能跑，但重启后在 noVNC 里会留下一个 about:blank 页签。要不要接由主 agent 定（我不改 index.ts）。

3. **`apply` 的 50 上限**是否需要和 D 的「全选」交互对齐（若 D 一次提交超 50，需要前端分批或加提示）。
4. **CDP 端口口径不一致**：A lane 的消息里写的是 `http://127.0.0.1:9222`，但仓库里 `docker-compose.yml`（`CAPTURE_CDP_PORT:-9223`）与 `server/routes/capture-env.ts` 的 `DEFAULT_CDP_URL` 都是 **9223**。我这边全部走 `getCdpUrl()` 动态取值、没有硬编码，所以不影响实现；但 NAS 上以哪个为准需要在验收前确认（否则 `/env` 会报 cdp:false）。
5. **`stop` 之后 SSE 仍保持 5s**：如果前端在 stop 响应后立刻 abort 掉 EventSource，看不到副作用；如果它重连，会收到 state+end 并立即关闭（已实测）。

## 风险与回滚

- 风险：新增代码全部是**新文件**，不改任何既有执行路径；`server/index.ts` 不挂载时这些模块完全不参与构建产物（`tsc` 会检查，`esbuild` 不会打包未被 import 的模块）。挂载后最大的风险是 CDP 不可达时 `/start` 返回 502——已按契约实现，且 `/env` 本来就是同样的降级策略。
- 回滚：`git revert <commit>` 即可；只会删掉 7 个新文件，`data/capture/` 是运行时目录（已 gitignore），回滚不丢用户的 hosts/屏蔽配置。

## 实现要点（对应验收关注的四条）

### 1) CDP 连接与重连策略

- 传输层 `CdpClient` 只做：连接、按 `id` 配对、超时 reject、断开时把挂起命令全部 reject（避免调用方永久 await）。重连是**业务决策**，放在 `session.ts`，这样传输层没有浏览器也能单测。
- `start` 的顺序是「先 `/json/version` 探活 → `/json/new` 开页 → 连 WS → `Network.enable` + `setCacheDisabled(true)` → `Page.navigate`」，任一步失败只清理自己开出来的那一个标签页。
- `Network.enable` / `setCacheDisabled` 用 10s 超时（冷启动的 Chromium 要好几秒才能响应），其余命令 3s。
- 断线：`onClose`（主动 `close()` 不触发）→ 退避 `200/600/1500ms` 重连**同一个 targetId**（标签页还在则 `webSocketDebuggerUrl` 不变）；成功后退避计数归零，失败 3 次 → 会话置 `failed`、推 `error` + `state` + `end` 三帧。标签页已消失时直接 failed（页面状态已丢，继续抓只会给空报告）。
- 重连后调 `tracker.beginEpoch()`：CDP 的 `requestId` 会从 1 重新编号，不换代会把新请求当成「重复」直接吞掉。上一代未完成的请求就地结账，不丢已捕获的数据。
- 时钟不混用：`totalMs` 用 CDP 的单调 `timestamp`（秒），`sweep` 的「挂了多久」用收到事件时的 `Date.now()`。两者不同源，混减会得出天文数字、把所有在途请求瞬间结账（单测 `sweep 只结账超时未完成的请求（按墙钟时间）` 覆盖）。

### 2) 单会话约束

- 三重保证：`live` 表里任何 `starting`/`running` 的会话存在即 409；另设 `starting` 布尔互斥——`start` 从「检查」到「建会话」之间隔着好几个 `await`（探活 + 开页 + WS 握手），没有它两个并发 `start` 会同时通过检查；`finally` 里必然复位。
- `manager` 在 `routes/capture.ts` 里是**模块级单例**：即使将来把 `/local/capture` 拆成两个子路由重复调用工厂，`live` 表仍是同一份。
- 409 文案用契约原文「已有抓包会话在运行」。

### 3) SSE 断线重连语义

- **end 帧后保持 5s 再关（主 agent 选定的方案 A）**。立刻关会有个实际窗口：前端刚收到 end 就断线，浏览器把这次断线当成网络抖动触发重连，于是又多一次 `/summary` 请求。留 5s 足够把最后一帧送出去。自测实测 `5001ms`。
- `end` 帧在 `stop` **返回之前**发出（`stop` 里先 `publish(state)` + `publish(end)`，再 `dispose` 落盘，最后才返回），不会出现「已停止但又来一条请求」。
- 连接进来先补一帧当前 `state`，然后**只推增量**，不重放历史（一次抓包上千条，重放既慢又会让前端出现重复行）；明细由前端调 `/:id` 与 `/:id/summary` 补全——这正是契约 §3 的约定。
- **重连到一个已结束的会话**：补 `state` + `end` 后**直接关**（不复用 5s 保持，反正没有后续数据）。自测实测关闭耗时 3ms。
- 15s 一条 `: ping` 注释行保活（反代/浏览器会掐掉静默连接）。
- 客户端断开（关页面/刷新）由 `stream.onAbort` + `c.req.raw.signal` 双路捕获，退订 + 清定时器；`CaptureStreamHub.publish` 对单个 sink 的异常做隔离，一个死连接不会让整场抓包丢帧。
- `stop` 里先把在途请求 `flush()` 结账、再发 `end`——顺序反了前端会看到「结束后又冒出新请求」。

### 4) 清理时不误伤用户的其它标签页

- 只关 `/json/new` 返回、记在会话里的那个 `targetId`；代码里**没有**任何批量关闭入口，`closeTarget` 对空 id / 含 `/` 的 id 直接返回。
- 从不复用用户已打开的标签页：`Page.navigate` 到别人的页面上会直接冲掉他正在看的内容。
- WS 是绑在单个 target 上的，所以收到的事件天然只属于自己那一页；不会因为「同一个浏览器」而混入其它标签页的数据。
- 自测里专门加了这条断言：先开一个「用户标签页」（`about:blank`），跑完 start→stop 后断言该标签页仍在、且 page 总数回到开始前（`page 数 3 → 3`）。
- 未处理的一条：进程被 `kill -9` 时无法关页签，会留下一个 about:blank。接上 `shutdownCaptureSessions()`（见待确认 2）或让 A 的 `capture-idle-stop.sh` 停容器即可回收。

## 合并建议

可合并。建议与会话相关的验收（NAS 上真实 headed 浏览器 + noVNC + 9223）放在**挂载之后**统一做一次：本地 headless 只能验逻辑，headless 的 `--remote-debugging-port` 绑定行为与生产不同；另外本机沙箱环境里 Chromium 自带 sandbox 起不来（GPU 进程崩溃会导致 `Network.enable` 无响应 / WS 1006），自测脚本因此带了 `--no-sandbox`，生产容器由 entrypoint 自己管，不受影响。
