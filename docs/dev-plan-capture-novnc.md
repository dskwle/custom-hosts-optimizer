# 开发任务分解：Chromium + noVNC 内嵌抓包 + Clash 输出

> 依据：`docs/design-capture-and-clash.md` 选定的 **容器内 Chromium + noVNC** 方案。
> 目标：把任务拆成可并行推进的泳道，先冻结契约，再各lane独立开发，最后集成。
> 规模：约 22 个任务，4 条可立即启动的并行泳道，1 条关键路径。

---

## 1. 目标架构

```
┌───────────── 浏览器（用户） ─────────────┐
│  控制台 /console   ┌────── iframe ─────┐ │
│  （已有，鉴权）     │  noVNC 客户端      │ │
└─────────┬──────────┴─────────┬─────────┘ │
          │ HTTP/SSE            │ WebSocket│
┌─────────▼─────────────────────▼──────────┐
│  app 容器（现有 custom-hosts，8788）       │
│  ├─ /local/capture/*  会话与事件（SSE）    │
│  ├─ /clash/*          公开规则端点         │
│  └─ capture/cdp.ts    ──────┐             │
└──────────────────────────────┼────────────┘
                               │ CDP (9222，仅容器网络)
┌──────────────────────────────▼────────────┐
│  chromium 容器（profile: capture）         │
│  Xvfb + openbox + Chromium(--remote-...)  │
│  x11vnc ──► novnc 容器（WebSocket 直连）    │
└────────────────────────────────────────────┘
```

要点：

- **CDP 端口绝不对外发布**，只在 compose 内网暴露给 app 容器。
- noVNC 单独一个容器（NAS 上已有 `theasp/novnc` 镜像可复用），对局域网发布一个端口。
- 抓包逻辑跑在现有 app 容器里（Node 已有 `ws` 能力），不新增 Node 服务。

---

## 2. 契约先行（T0，串行起点，其余全部依赖它）

先写 `docs/api-capture.md` 冻结以下内容，之后各 lane 对着契约开发，互不阻塞：

```ts
type CaptureStatus = 'starting' | 'running' | 'stopped' | 'failed'

interface CaptureSession {
  id: string
  url: string
  status: CaptureStatus
  startedAt: string
  endedAt?: string
  requestCount: number
  note?: string
}

interface CapturedRequest {
  requestId: string
  host: string
  url?: string          // 默认不落盘，见 D5 隐私开关
  type: 'document' | 'script' | 'xhr' | 'img' | 'font' | 'media' | 'other'
  status?: number
  ttfbMs?: number
  totalMs?: number
  bytes?: number
  failed?: boolean
  errorText?: string
  cached?: boolean
  frameId?: string
}

interface HostSummary {
  host: string
  requests: number
  failures: number
  p95TtfbMs?: number
  p95TotalMs?: number
  bytes: number
  thirdParty: boolean
  kinds: string[]
  verdict: 'accel' | 'block' | 'proxy' | 'ignore' | 'unknown'
  reason: string        // 给用户看的一句话依据
  suggested: boolean    // 默认是否勾选
}
```

REST 契约：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/local/capture/start` | `{url, storeUrls?}` → `{session}` |
| GET | `/local/capture` | 会话列表（最近 N 条） |
| GET | `/local/capture/:id` | 会话详情 + 原始请求 |
| GET | `/local/capture/:id/summary` | 按 host 聚合（C 的实现） |
| GET | `/local/capture/:id/stream` | SSE：`{type:'request'|'state', data}` |
| POST | `/local/capture/:id/stop` | 停止并落盘 |
| POST | `/local/capture/apply` | `{hosts:[], action:'accel'|'block'}` |
| GET | `/local/capture/env` | 环境自检：CDP 是否可达、Chromium 版本 |

公开端点（无需鉴权，与 `/host*` 同级）：`/clash/hosts.yaml`、`/clash/block.yaml`、`/clash/proxy.yaml`、`/clash/snippet.yaml`。

> **T0 的验收标准**：C 和 D 能拿这份契约 + 一个 mock server（返回固定 fixture）独立开发，不需要 B 完成。

---

## 3. 任务分解（按泳道）

标记：`∥` 可与本 lane 内其他任务并行；`⤵` 依赖前置任务。

### Lane A — 运行环境（可立即开始）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| A1 ∥ | compose 增加 `capture` profile：`chromium` + `novnc` 两个 service | — | `profiles: ["capture"]`，不加 profile 时完全不启动，不影响现有部署 |
| A2 ∥ | Chromium 启动参数与镜像选择 | A1 | `--remote-debugging-port=9222 --remote-allow-origins=* --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/chrome`；优先 `linuxserver/chromium`（自带 Xvfb+x11vnc） |
| A3 | CDP 可达性自检 + `/local/capture/env` 接口 | A2, T0 | 连不上时前端要给明确提示，而不是白屏 |
| A4 ∥ | noVNC 接入：容器端口、连接参数（`?autoconnect=1&resize=scale&reconnect=1`） | A1 | 先用直连 iframe；是否经 app 反代由 F3 决策 |
| A5 ∥ | 资源治理：内存上限（`mem_limit`）、空闲 10 分钟自动停、`restart: unless-stopped` | A1 | NAS 长期跑 Chromium 要控内存 |

**A 的验收**：`docker compose --profile capture up -d` 后，浏览器打开 noVNC 端口能看到一个可操作的 Chromium；`curl app:8788/local/capture/env` 返回 CDP 可达。

### Lane B — 抓包后端（依赖 T0，A3 后联调）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| B1 | CDP 客户端封装（ws + 请求/响应 id 配对、超时、重连） | T0 | 不加 puppeteer，自己写最小客户端，省 300MB 依赖 |
| B2 | target 发现与 attach：新建/复用标签页、激活、`Page.navigate` | B1 | |
| B3 | 事件采集：4 类 Network 事件 → 内部缓冲，计算 ttfb/total，过滤缓存 | B2, T0 | 口径见设计文档 2.3 |
| B4 | 会话管理：start/stop/list/get，落盘 `data/capture/<id>.json`，保留最近 20 条/7 天 | B2 | |
| B5 | SSE 推送 `/stream`（新请求增量 + 状态变化） | B3 | 注意容器内 keep-alive 与断线重连 |
| B6 ∥ | 会话打开增强：禁缓存、SW 处理、多 frame 归属、导航失败态 | B2 | |
| B7 ∥ | `/local/capture/apply`：把选中的 host 交给现有 probe/adopt/blocklist | T0（可 mock 先行） | 复用查重与提示，不写新逻辑 |

**B 的验收**：`POST /start` 打开一个真实站点，`/summary` 能列出 host 与耗时，`/stream` 能实时推。

### Lane C — 聚合与判定（可立即开始，用 fixture 开发）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| C1 ∥ | 按 host 聚合：请求数、失败数、p50/p95、字节、类型分布 | T0 | 输入可先用 `data/capture/fixtures/*.json` |
| C2 ∥ | 第一方/第三方判定（eTLD+1，建议引入 `tldts`，约 40KB） | C1 | 避免把 `api.github.com` 和 `gist.github.com` 判成同站 |
| C3 | 建议引擎：规则矩阵 → `verdict` + `reason` + `suggested` | C1, C2 | 规则表见设计文档 2.4，硬编码在 `server/capture/advice.ts` |
| C4 | 与探测联动：对候选批量 probe，SNI 阻断 → `proxy`，无 IP → `block` | B7, C3 | 复用 `/local/probe`，注意并发 3 限流 |
| C5 ∥ | 单测：fixture 驱动，覆盖慢/超时/缓存/SW/第一方 | C1–C3 | 这是唯一能脱网即测的部分，优先做 |

**C 的验收**：给定 fixture，输出与人工预期一致的 `HostSummary[]`，单测覆盖 8 种典型场景。

### Lane D — 控制台 UI（可立即开始，用 mock）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| D1 ∥ | 新标签页「网页诊断」：网址输入、开始/停止、状态条 | T0 | 与其他标签页风格一致 |
| D2 ∥ | noVNC iframe 区域：加载中/失败重试/全屏按钮 | A4, T0 | 高度自适应，避免挤压请求表 |
| D3 ∥ | 请求表格：列定义、筛选（全部/慢/失败/第三方）、排序、全选/反选 | T0（mock） | |
| D4 ∥ | SSE 增量渲染（节流到 200ms，避免频繁重排） | B5 | 契约稳定后接真接口 |
| D5 | 应用动作：测速并加速 / 加入屏蔽 / 导出；含查重与结果提示 | B7 | 复用现有 toast 与提示文案 |
| D6 ∥ | 会话历史：列表 + 回看报告（点击进入只读视图） | B4 | |
| D7 ∥ | 隐私开关：是否记录完整 URL（默认只存 host） | T0 | |

**D 的验收**：mock 数据下全流程可点；接真接口后无需改结构。

### Lane E — Clash 输出（与抓包完全独立，可立即开始）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| E1 ∥ | `/clash/hosts.yaml`：加速域名 → `hosts:` 映射（含 IPv6） | — | 公开端点，格式 `{domain: [ip]}` |
| E2 ∥ | `/clash/block.yaml`：屏蔽域名 → `payload` 列表（behavior: domain） | — | 含内置屏蔽 + 手动屏蔽 + 广告规则；单独 `/clash/ads.yaml` 便于开关 |
| E3 ∥ | `/clash/proxy.yaml`：SNI 阻断域名列表（交给用户映射 PROXY） | — | 数据源：blocked list |
| E4 ∥ | `/clash/snippet.yaml`：可直接粘的合并片段（hosts + rule-providers + rules） | E1–E3 | 带注释说明粘到哪里 |
| E5 ∥ | 完整配置模板 `/clash/config.example.yaml` | E4 | 含 `dns.use-hosts`、fake-ip、TUN 注释、proxy-group 占位 |
| E6 ∥ | 控制台「规则输出」卡片：复制片段 / 下载 / 端点说明 | E4 | 放在 Hosts 标签页下方即可 |
| E7 | 自动化验证脚本：起临时 mihomo 容器跑一遍断言 | E1–E4 | 把本次手工验证固化（已有可用脚本雏形） |

**E 的验收**：拉取 snippet → 粘到 mihomo → 加速域名解析到指定 IP、屏蔽域名被 REJECT（E7 自动断言）。

### Lane F — 集成与验收（依赖 A–D）

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| F1 | 端到端：抓包 → 勾选 → 加速 → `/host` 与 `/clash/hosts` 双端生效 | A–E | |
| F2 | 误伤回归：选 5 个真实站点，对比屏蔽前后页面可用性 | D5 | 记录"建议"命中率，校准 C3 阈值 |
| F3 | 安全复核：CDP 不对外、`/clash/*` 公开范围、noVNC 是否需鉴权 | A4 | 决策点见 §6 |
| F4 | 资源与性能：Chromium 常驻内存、会话并发上限、SSE 连接数 | A5 | |
| F5 | 文档与截图：README、设计文档回填实测数据 | 全部 | |

---

## 4. 并行排布

```
周次     1        2        3        4
T0   ██
A    ████████
B         ████████████
C    ████████████                 (fixture 先行)
D    ████████████████             (mock 先行)
E    ████████████                 (完全独立，可最先交付)
F                          ██████████
```

**可立即同时启动的四条**：A（环境）、C（聚合，fixture）、D（UI，mock）、E（Clash）。

**关键路径**：`T0 → B1/B3 → C1 → D3 → F1`。B 是唯一不能提前太多的环节，但 A 完成后它就能联调。

**建议的合并顺序**：E → A → B+C → D → F。E 最先可交付（离线可验、无依赖），能最快产生用户价值；A 完成后 B 才有环境；C 与 D 各自对着 mock 完成后与 B 对接。

---

## 5. 可并行的前提：三份"假数据"

为了让 C/D 不等 B：

1. **fixture**：`server/capture/fixtures/*.json`——录 3 个真实站点的 CDP 事件流（github.com / 一个视频站 / 一个广告多的资讯站），C 和 D 都用它。
2. **mock server**：`scripts/mock-capture.mjs`——按契约返回假会话、假摘要、假 SSE 流。
3. **契约文档**：`docs/api-capture.md`（T0 产出）。

有这三样，C 与 D 可以在 B 还在写 CDP 客户端时就把逻辑和界面做完。

---

## 6. 需要你拍板的 4 个决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| 1 | noVNC 要不要经 app 反代 | 直连 `:8888` / 反代 `/vnc` 加鉴权 | **先直连**（局域网内），F3 再评估反代；反代要处理 WebSocket 升级，成本不低 |
| 2 | 一次能开几个抓包会话 | 单会话 / 多会话 | **单会话**（Chromium 单实例），并发会话需多容器，不划算 |
| 3 | 是否记录完整 URL | 只存 host / 存 URL | **默认只存 host**，开关可开；URL 可能含 token |
| 4 | Clash 的 `PROXY` 目标 | 固定组名 `PROXY` / 可配置 | 固定 `PROXY` 并在片段注释里说明"改成你自己的策略组名" |

顺带的取舍说明：Chromium 容器只在 `--profile capture` 时启动，**默认部署不受影响**；这部分我建议做成"用时启动、闲置 10 分钟自动停"，避免 NAS 长期吃 500MB 内存。

---

## 7. 交付物清单

- `docker-compose.yml` 增加 `capture` profile（chromium + novnc）
- `server/capture/`：`cdp.ts`（客户端）、`session.ts`（会话）、`aggregate.ts`（聚合）、`advice.ts`（建议）、`store.ts`（落盘）
- `server/index.ts` 新增 8 个 `/local/capture/*` 路由
- `src/index.ts` 或独立模块新增 `/clash/*` 4 个公开端点
- `public/console.html` 新增「网页诊断」标签页 + 「规则输出」卡片
- `docs/api-capture.md`、`docs/design-capture-and-clash.md`（回填实测）
- `scripts/mock-capture.mjs`、`scripts/verify-clash.mjs`
- 单测：`server/capture/*.test.ts`
