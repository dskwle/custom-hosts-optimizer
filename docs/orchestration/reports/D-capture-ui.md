# D1–D3/D5–D7 控制台「网页诊断」标签页

- **结论**：可合并（一处需主 agent/A 确认：noVNC 默认端口）
- **Lane / Owner**：D / agent-D
- **分支 / 基线**：`feat/D-capture-ui` @ `a765f37`（从 `integration/capture@a765f37` 切出）
- **状态**：REPORTED
- **报告时间**：2026-11-21 11:25

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

### 自动化验收（CDP 驱动，共 21 项断言，全部 PASS）

```
PASS  1000 行只渲染前 200 行  — rows=200, foot="已显示 200/1000 个，滚动表格加载更多"
PASS  行数统计正确  — 1000 个域名
PASS  滚动触发追加加载  — rows=400
PASS  慢请求筛选（p95>5s）  — 200 个域名
PASS  失败筛选非空  — 91 个域名
PASS  排序方向可切换  — h0999 → h0000, 按钮=升序
PASS  全选选中当前筛选下全部（已渲染行同步勾选）  — 200 行勾选, 测速并加速(1000)
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
2. **noVNC 默认端口**：任务书写 6080，但 `docs/dev-plan-capture-novnc.md` L224 与
   `docs/design-capture-and-clash.md` L49/L186 写的是 NAS 上现有 novnc 的 **8888**。
   当前实现默认 6080，并可用 `?vncPort=` / `?vnc=` 覆盖，等 A 确认 compose 里实际 publish 的端口后再定默认值。
   已发消息问 agent-A，尚未收到回复。
3. **历史会话是否允许直接应用**：按任务书「只读」实现了（历史会话下两个按钮禁用，提示「历史会话只读」）。
   如果产品上希望「回看旧会话也能一键加速」，去掉 `capSyncActions` 里的 `cap.history` 条件即可。
4. **`GET /local/capture?limit=20` 的挂载形式**：契约表格写 `GET /?limit=20`，mock 实现的是
   `/local/capture?limit=20`（无尾斜杠）。前端按 mock 的写法调用，若 B 用了尾斜杠形式请告知，改一处字符串即可。

## 风险与回滚

- 风险：noVNC 端口猜错 → 内嵌区域显示「连接不上内嵌浏览器」+ 重试按钮，不影响抓包与请求表（已实测该降级路径）
- 风险：页签宽度窄于 ~900px 时，请求表出现横向滚动（表内 8 列不折行），信息不丢只是需要横滑
- 回滚：`git revert <commit>` 即可；本次只改一个静态文件，无数据迁移、无接口变更

## 合并建议

可合并。建议与 B 的 `/local/capture/*` 一起进 `integration/capture` 后做一次真机联调
（真实 Chromium + noVNC + 真实 `/apply`），在此之前前端在 404/502 下是自洽的降级状态。

---

## 审查记录（主 agent 填写，子 agent 不动这节）
