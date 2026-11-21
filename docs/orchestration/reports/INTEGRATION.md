# 集成验收记录（F 阶段）

> 项目：内嵌抓包（Chromium + noVNC）+ Clash 规则输出
> 集成分支：`integration/capture` → 快进到 `local-runtime` @ `a35fca9`
> 日期：2026-11-21

---

## 1. 合并记录

| 顺序 | Lane | 合并内容 | 提交 |
|---|---|---|---|
| 0 | T0 | 契约、门禁、worktree 引导、mock | `a765f37` / `e813850` |
| 1 | E | `/clash/*` 五个端点 + 片段/模板 | `b0c95e9`（+ 路由挂载 `ad3d095`） |
| 2 | A | capture profile（Chromium + noVNC）、`/env` 自检 | `641fe3c`（两轮返工后） |
| 3 | C | 聚合与建议（契约 v1.1） | `bb058b6` |
| 4 | D | 控制台「网页诊断」+ 分批 apply | `cbe660d` / `739d893` / `c0fe658` |
| 5 | B | 抓包后端（CDP/SSE/apply） | `1002555` + 修复合并 |
| — | E7 | 验证脚本断言修正 | `be04fde` |

返工统计：A 两轮（headless、CDP 绑定地址），E 一轮（harness 断言），C 一轮（契约 v1.1 跟进），D 两轮（口径对齐、分批）。全部走"打回 → 原分支追加 commit → 复验"，没有跳过审查直接合并的情况。

---

## 2. 端到端（F1）

真实环境：NAS 上的 **headed Chromium**（跑在 noVNC 里，CDP 在宿主 `127.0.0.1:9223`），不是 headless。

```
GET /local/capture/env
→ {"cdp":true,"version":"124.0.6367.78","chromium":"Chrome/124.0.6367.78"}

POST /local/capture/start {"url":"https://www.debian.org"}
→ 24 条请求 / 1 个域名，状态 running

GET /summary
→ www.debian.org 24 req, 1714ms, verdict=unknown, suggested=false

POST /apply {"hosts":["github.com","www.debian.org"],"action":"accel"}
→ {"added":["www.debian.org"],
   "skipped":[{"domain":"github.com","reason":"内置加速"}]}

GET /host              → 2215 → 2216 行，含 www.debian.org
GET /clash/hosts.yaml  → 含 "www.debian.org"

POST /apply {"hosts":["example.org"],"action":"block"}
→ /host_block 的 0.0.0.0 行 990 → 991（v4/v6 各一条）

再次 start → 409 {"error":"已有抓包会话在运行"}
```

SSE 语义（方案 A）：

- 运行中收到 `end` 后连接再保持 5s，让前端收完最后一帧
- 重连已结束的会话：补 `state` + `end` 后立即关闭（实测 32ms）

---

## 3. 误伤回归（F2）：一个必须告知用户的限制

实测对象 `https://www.pcgamer.com/`：

| 阶段 | 请求数 | 域名数 | document |
|---|---|---|---|
| 屏蔽前 | 193 | 52 | 200 |
| 加屏蔽 6 个第三方域名后 | 190 | 47 | 200 |

看起来"少了 3 个请求"，但其实**那 6 个域名仍在被请求**（`analytics.tiktok.com`、`pagead2.googlesyndication.com`、`connect.facebook.net`、`engage.vanilla.tools` 都还在列表里）。差异只是页面广告的随机波动。

原因不是功能坏了，是拓扑决定：屏蔽写进的是 hosts / Clash 配置，而抓包浏览器跑在容器里、走容器自己的 DNS，**不读这份 hosts**。

结论与处理：

1. 这是**产品必须显式说明**的点，已写进控制台提示（「加速与屏蔽只作用于导出的 hosts / Clash 配置…重新抓包仍会看到请求」）和 README
2. 真正的误伤验证只能在"规则生效的客户端"上做——即用户把 `/host` 或 `/clash/*` 应用到自己的系统/代理之后
3. 如果要在这个工具里自证屏蔽效果，需要让抓包浏览器走 mihomo 代理（给 Chromium 加 `--proxy-server`），属于后续增强，不在本期范围

---

## 4. 资源与回归（F3/F4）

| 容器 | 空闲内存 | 上限 | CPU |
|---|---|---|---|
| custom-hosts（app） | 21.6 MB | — | 0.1% |
| chromium | 122 MB | 1 GB | 0.2% |
| novnc | 107 MB | 256 MB | 1.4% |
| refresher | 0.5 MB | — | 0% |

- 抓包容器默认**不启动**（`profiles: ["capture"]`），不加 profile 时对现有部署零影响
- 会话落盘：3 个会话共 12 KB（默认只存 host，不存 URL）
- `/host` 行数在全部合并后仍为 **2215**，与合并前基线一致
- 门禁：`./scripts/check.sh` 全绿（tsc 0 error、build 通过、内联 JS 语法 OK、**87 个单测**）
- 鉴权边界复验：`/host*`、`/clash/*` 公开 200；`/`、`/local/*`、`/api/*` 未登录 401

---

## 5. 期间发现并修复的问题（按发现顺序）

| 问题 | 影响 | 处理 |
|---|---|---|
| `zenika/alpine-chrome` 的 entrypoint 固定 `--headless` | noVNC 里没有浏览器画面 | 清空 entrypoint，自己 exec 二进制 |
| headed Chrome 忽略 `--remote-debugging-address`，只绑容器 loopback | 宿主映射的 9222 永远连不上 | chromium 改 host 网络，CDP 落宿主 loopback 9223 |
| Hono `use()` 只对之后注册的路由生效 | `/local/capture/env` 未登录也能 200 | 两个 mount 移到鉴权中间件之后 |
| 批量刷新把并发超时误判成 SNI 阻断 | 32 条阻断里 23 条是误判 | 判定后追加二次复核，两次都阻断才入库 |
| mock 脚本 `rec` 未定义 | `/start` 后 250ms 必崩 | 先 `const rec = {...}` 再 set |
| 前端 apply 一次性提交 | 全选 >50 个域名直接 400 | 按 50 分批顺序提交，失败即停并保留已成功部分 |

---

## 6. 遗留 backlog（未做，按优先级）

1. **noVNC 鉴权**：当前直连 6080 无鉴权，只能靠"仅可信局域网"约束；远程访问需前置反代（文档给了 nginx + WS 升级片段）
2. **CJK 字体**：精简 chromium 镜像缺中文字体，页面中文可能显示方块（不影响抓包列表）
3. **历史会话只读**：回看旧会话不能再应用（旧 IP 可能过期，故意限制）
4. **分批进度粒度**：50 个一批时中间十几秒无反馈，可考虑调小 `CAP_APPLY_BATCH` 或 per-host 进度（需契约变更）
5. **屏蔽效果自证**：让抓包浏览器走 mihomo，可在工具内直接验证屏蔽前后差异
6. **`/apply` 上限**：`APPLY_MAX_HOSTS` 与 `PROBE_CONCURRENCY` 需同步调整，只调前者会把单批拖得很慢
