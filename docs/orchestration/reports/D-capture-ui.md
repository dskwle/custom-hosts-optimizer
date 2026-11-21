# D1–D3/D5–D7 控制台「网页诊断」标签页

- **结论**：可合并
- **Lane / Owner**：D / agent-D
- **分支 / 基线**：`feat/D-capture-ui`（从 `integration/capture@a765f37` 切出，三个提交：主体 / 契约 v1.1 与 noVNC 跟进 / apply 分批）
- **状态**：REPORTED（第 3 版，已并入 A 的端口确认、C 的 v1.1 口径、B 的 `/apply` 50 上限）
- **报告时间**：2026-11-21 12:20

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `public/console.html` | +990/-0 | 新增第 8 个标签页「网页诊断」：样式（L174–220）、标签按钮（L238）、页面结构（L421–536）、标签切换钩子（L574）、业务逻辑（L1784–2608） |
| `docs/orchestration/reports/d-shots/*.png` | 新增 4 张 | mock 下截图（初始态 / 抓到数据后 / 各自整页版） |
| `docs/orchestration/reports/D-capture-ui.md` | 新增 | 本报告 |

> 是否触碰非本 lane 拥有的文件：**否**。未改任何 `.ts` / `.mjs` / `docker-compose.yml` / `package.json` / `scripts/`。
> 说明：`git add -A` 会把 worktree 里的 `node_modules` **符号链接**一起提交（`.gitignore` 里写的是 `node_modules/`，匹配不到符号链接），
> 因此本次只 `git add` 了上述三个路径，未使用 `-A`。

### console.html 改动分区

| 区块 | 行号 | 内容 |
|---|---|---|
| CSS | 174–220 | `.cap-layout` / `.cap-vnc-*` / `.cap-table-wrap`（表头 sticky）/ `.cap-foot` / `.cap-rule-row` |
| 标签按钮 | 238 | `<div class="tab" data-tab="capture">网页诊断</div>` |
| 页面结构 | 421–536 | 控制卡（网址、开始/停止、状态条、会话下拉）、左右两栏（noVNC + 请求表）、规则输出卡 |
| 标签切换 | 574 | `if (name === 'capture') capOnShow()`（懒初始化，不拖慢其它页签） |
| 业务逻辑 | 1784–2608 | `capFetch` / noVNC / 抓包控制 / SSE / summary 节流 / 表格分批 / apply / 会话历史 / 规则输出 |

## 验收自测

```bash
$ ./scripts/check.sh
== TypeScript ==
（无输出即通过）
== Build (local runtime) ==
  dist-server/index.mjs  111.6kb
⚡ Done in 14ms
== Console inline JS syntax ==
script[0] 语法 OK（2154 行）
== Unit tests ==
（暂无测试文件，跳过）

全部通过
exit=0
```

### 联调环境

- mock：`node scripts/mock-capture.mjs --port 8899` —— **该文件有 bug，见「待确认问题 1」**，
  本次用它的修复副本（只改 `s.requests` → `rec.requests`）跑在 `/tmp`，仓库里的文件未动
- 静态服务：`python3 -m http.server 8877`（`public/`），访问 `console.html?captureMock=8899`
- noVNC：本机没有真 noVNC，用 6080 端口的一个占位页（`/tmp/vnc-stub`）验证 iframe 通路，
  截图里那块黑底「noVNC 占位」就是它，真实环境应是容器内 Chromium 画面
- 浏览器：本机 WorkBuddy 浏览器截图通道中途失效（`Current display surface not available`），
  改用**无头 Edge + CDP**（`--headless=new --no-sandbox --in-process-gpu`，1440×1000@1x）出图，
  脚本在 `/tmp/shoot.mjs`，未入库

### 自动化验收（CDP 驱动，共 34 项断言，全部 PASS）

```
PASS  1000 行只渲染前 200 行  — rows=200, foot="已显示 200/1000 个，滚动表格加载更多"
PASS  行数统计正确  — 1000 个域名
PASS  滚动触发追加加载  — rows=400
PASS  慢请求筛选（p95>5s）  — 200 个域名
PASS  失败筛选非空  — 91 个域名
PASS  排序方向可切换  — h0999 → h0000, 按钮=升序
PASS  全选勾选全部可勾选行（proxy 除外）  — 194/194 行, 计数=972 / 可勾选=972
PASS  反选生效  — 测速并加速(0)
PASS  apply 文案区分新增/已内置/失败  — 完成：加速 2 个，2 个已内置，1 个失败（写入失败）
PASS  回看历史会话隐藏 noVNC  — display=none
PASS  历史会话只读  — disabled=true, "历史会话只读"
PASS  历史会话能加载表格  — rows=6, status=回看会话（6 个域名）
PASS  未就绪时状态条降级  — 服务未就绪
PASS  未就绪时给出提示  — 抓包服务未就绪（Chromium 未启动或后端未合并）
PASS  未就绪不阻塞其它页签  — hosts=block, cap=none
PASS  未就绪点「开始抓包」有提示且按钮恢复
PASS  全屏按钮铺满视口  — card=1000px, box=897px, 按钮变「退出全屏」
PASS  Esc 退出全屏
PASS  SSE 断线（CDP 断网 1.2s）后自动重连  — 恢复后 10 个请求 / 6 个域名
PASS  重连后 summary 补全不漏数据
PASS  抓包中通道静默失效被看门狗重建  — 新 EventSource readyState=1
PASS  规则 404 时提示「规则输出未启用」
PASS  proxy 行没有勾选框  — proxy=6, 带框=0, 其余带框=194
PASS  失败列带 timeouts tooltip  — title="1 个超时"
PASS  端口通时 iframe 加载成功  — badge=已加载
PASS  重试 URL 带 _t 缓存穿透  — ...&_t=1795232205371

# /apply 分批（stub 复刻 B 的 50 上限 + 记录请求大小与并发度）
PASS  120 个域名切成 3 批  — [50,50,20]
PASS  逐批顺序提交（无并发）  — maxConcurrent=1
PASS  每批在上一批返回后才发  — 三批 t0 均 ≥ 上一批 t1
PASS  过程中显示批次进度  — 正在加速 1/3 批…
PASS  提交中按钮禁用  — 两个按钮都 disabled
PASS  汇总文案  — 完成：加速 120 个
PASS  完成后已选清空、按钮随之置灰  — 测速并加速(0)
PASS  ≤50 时只发 1 次请求  — 1 次 / [30]
PASS  单批文案与原来一致  — 完成：加速 30 个
PASS  第 2 批 500 后不再发第 3 批  — 共 2 次请求
PASS  文案说明已提交批次与中断原因  — 已提交 1/3 批（加速 50 个），中断：第 2 批写入失败
PASS  第 1 批的成果照常展示  — 加速 50 个
PASS  已成功域名从勾选里移除  — 测速并加速(70)
```

关键点：

- **分批渲染**：1000 个域名首次只写 200 行 DOM，滚到底追加 200 行（`capAppendMore`），实测无卡顿
- **渲染节流**：SSE 的 `request` 帧只累加计数并触发一次 250ms 合并窗口内的 `/summary` 拉取，
  同一时刻最多一个在途请求（`capSummaryBusy`），不会每条 `innerHTML +=`
- **断线补全**：`onopen` 与 3 秒看门狗都会补一次 `/summary`，服务端只推增量的约定不会导致漏数
- **降级**：`/local/capture/*` 的 404/501/502 与网络错误统一收敛为「抓包服务未就绪」，其它页签照常工作

### 截图

| 文件 | 内容 |
|---|---|
| `d-shots/d-01-initial.png` | 初始态：状态「未开始」、表格提示「尚未开始抓包」、按钮 `(0)` 且禁用、CDP 就绪 |
| `d-shots/d-02-captured.png` | 抓到 10 个请求后的表格：6 个域名、按 p95 降序、预选 4 个、`测速并加速(4)` |
| `d-shots/d-03-initial-full.png` | 初始态整页（含底部规则输出卡） |
| `d-shots/d-04-captured-full.png` | 抓包后整页 |

## 契约偏差

无。按 `contracts/api-capture.md` 实现：

- 只调 `GET /env`、`POST /start`、`GET /?limit=20`、`GET /:id`、`GET /:id/summary`、`POST /:id/stop`、`GET /:id/stream`、`POST /apply`
- SSE 只消费 `state` / `request` / `error` / `end` 四种帧；`end` 后不再重连
- 表格列全部取自 `HostSummary`（p95 优先 `p95TotalMs`，缺失时退化到 `p95TtfbMs`；`verdict`/`reason`/`suggested` 原样展示，前端不做二次判定）
- 「慢」的筛选口径按契约 `SLOW`（p95 > 5000ms），与 C 的判定一致
- `p50TtfbMs` / `p95TtfbMs` / `p95TotalMs` 为 `undefined`（全部缓存命中）时显示 `—`，不会显示成 `0ms`

### 实现约束：`POST /apply` 单次上限 50（B 的实现细节，契约未写）

B 的 `/apply` 对超过 50 个域名直接 `400 {"error":"单次最多 50 个域名，请分批提交"}`（每个 accel 域名要现场 probe）。
前端按 `CAP_APPLY_BATCH = 50` 切片、**顺序**提交（不 `Promise.all`，避免 probe 互相拖慢）：

- 单批（≤50）走一次请求，行为与改动前完全一致，不额外加请求
- 多批时状态条显示「正在加速 2/3 批…」，提交期间两个按钮禁用防重复提交
- `added / skipped / failed` 跨批累加后一次性汇总；成功新增的域名从勾选里移除
- 某批返回非 2xx 立即停止后续批次，文案变成「已提交 1/3 批（加速 50 个），中断：<原因>」，已成功的照常展示

### 契约 v1.1 跟进（C 的 `feat/C-aggregate @ 3f501d3`）

- **`verdict='proxy'` 的行不给勾选框**，也不参与全选/反选/默认预选（改 hosts 无效，只提示加 Clash proxy 规则）。
  实现在 `capRowHtml` 的 `selectable` 与 `capApplySummary` / 全选 / 反选三处，`proxy` 与 `accel`/`block` 可在同一批结果里共存。
- **`HostSummary.timeouts`**：没有单独加列（表格已 8 列、宽度紧张），改为「失败」单元格的 `title`（如「2 个超时」），
  完整文案由 C 写进 `reason`；字段缺失时按 `?? 0` 兜底。

前端额外加了三个**仅本地开发用**的 URL 开关（都写在注释里，不影响生产）：

| 参数 | 作用 |
|---|---|
| `?captureMock=8899` | 抓包相关请求打到 `http://127.0.0.1:8899`，其余接口仍走 `API` |
| `?vnc=<完整 URL>` | 整体覆盖 noVNC 地址 |
| `?vncPort=8888` | 只换 noVNC 端口，主机名仍取当前页面 |

## 待确认问题

1. **`scripts/mock-capture.mjs` 首个请求就崩溃**（P0，该文件归主 agent）：
   `POST /start` 里把请求存进 `rec.requests`，但定时器写的是 `s.requests`（session 对象上没有该字段），
   于是 `s.requests = [...s.requests, r]` 抛 `TypeError: s.requests is not iterable`，进程直接退出。
   现象：前端只看到 `state: running` + 0 条数据。修复只需把 L143–146 的三处 `s.requests` 改成 `rec.requests`
   （我已在 `/tmp` 副本上验证）。**建议主 agent 修完再让 B/C 用它联调。**
2. **历史会话是否允许直接应用**：按任务书「只读」实现了（历史会话下两个按钮禁用，提示「历史会话只读」）。
   如果产品上希望「回看旧会话也能一键加速」，去掉 `capSyncActions` 里的 `cap.history` 条件即可。
3. **`GET /local/capture?limit=20` 的挂载形式**：契约表格写 `GET /?limit=20`，mock 实现的是
   `/local/capture?limit=20`（无尾斜杠）。前端按 mock 的写法调用，若 B 用了尾斜杠形式请告知，改一处字符串即可。

### 已确认（本版并入）

- **noVNC 端口 = 6080**（agent-A 确认：compose 里 `${CAPTURE_NOVNC_PORT:-6080}:8080`，容器内部 8080）。
  8888 是 NAS 上另一个独立 novnc 容器，指过去会看不到抓包浏览器，所以默认值用 6080；
  前端留了 `CAP_VNC_PORT` 常量 + `?vncPort=` / `?vnc=` 双覆盖，将来若改成 `/vnc/` 反代只换 base 即可。
- 直连发布端口、不经 app 反代；noVNC 前端是静态页，**重试时带 `_t=<ts>` 绕过浏览器缓存**（A 的建议）。
- 镜像零鉴权、可能缺中文字体、单实例这三条限制已写进「内嵌浏览器」卡片的说明文字。

## 风险与回滚

- 风险：noVNC 端口猜错 → 内嵌区域显示「连接不上内嵌浏览器」+ 重试按钮，不影响抓包与请求表（已实测该降级路径）
- 风险：页签宽度窄于 ~900px 时，请求表出现横向滚动（表内 8 列不折行），信息不丢只是需要横滑
- 回滚：`git revert <commit>` 即可；本次只改一个静态文件，无数据迁移、无接口变更

## 合并建议

可合并。建议与 B 的 `/local/capture/*` 一起进 `integration/capture` 后做一次真机联调
（真实 Chromium + noVNC + 真实 `/apply`），在此之前前端在 404/502 下是自洽的降级状态。

---

## 审查记录（主 agent 填写，子 agent 不动这节）
