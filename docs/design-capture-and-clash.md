# 设计文档：内嵌抓包诊断 + Clash 规则输出

> 状态：**方案研究**，不含代码改动。目的是回答两个"能不能做、值不值得做、坑在哪"。
> 结论先行：两件都可行，第二件已经在本机实测通过；第一件的难点不在抓包，而在"抓包跑在哪儿"和"自动去除的边界"。

---

## 0. 结论摘要

| 议题 | 可行性 | 一句话结论 |
|---|---|---|
| 内嵌浏览器抓请求 + 慢请求识别 | 可行 | 用 Chrome DevTools Protocol 抓，数据足够。iframe 方案不可行（拿不到 timing），"内嵌"需 CDP screencast 或 noVNC |
| 自动识别 >5s 并"自动去除" | 部分可行 | 识别没问题；"去除"只能是屏蔽该域名，必然影响整站，**建议自动标记、人工确认，不自动生效** |
| 勾选后检测加速 / 屏蔽 | 完全可行 | 复用现有 `/local/probe` 与 `/local/adopt`，链路已存在 |
| 生成 Clash/mihomo 规则 | **可行，已实测** | `hosts:` 做加速、`RULE-SET + REJECT` 做屏蔽；已用 mihomo 容器验证端到端生效 |

---

## 1. 现状与可复用能力

已有能力（不需要重做）：

- 域名探测：`probeDomain()` —— AliDNS + DNSPod 交叉解析、候选 IP 全量测速、TLS 硬校验、双 SNI 对照判定
- 四类规则数据：内置加速（`SITE_GROUPS`）、内置屏蔽（`BUILTIN_BLOCKLIST`）、手动加速（KV）、手动屏蔽（KV）
- 输出通道：`/host`、`/host_fast`、`/host_block`、`/hosts.json`
- 控制台：7 个标签页，查询/一键对调/批量检测都已具备

本方案要补的是两件事：**怎么发现"网页里到底有哪些域名在拖后腿"**，以及**怎么把结论喂给代理软件**。

---

## 2. 方案一：内嵌浏览器抓包

### 2.1 目标拆解

```
打开网页 → 捕获全部子请求 → 按耗时/失败标注 → 聚合到域名
        → 勾选 → 分为"可加速 / 需屏蔽 / 走代理" → 一键应用
```

### 2.2 技术选型：谁来做"内嵌浏览器"

| 方案 | 能拿到请求耗时 | 内嵌观感 | 改动量 | 主要问题 |
|---|---|---|---|---|
| `<iframe>` 嵌目标站 | ❌ | ✓ | 小 | 跨域拿不到 `PerformanceResourceTiming`；大量站点 `X-Frame-Options` / CSP 直接拒绝被嵌 |
| Electron `BrowserView` | ✓ | ✓✓ | **大** | 要把整个控制台换成 Electron 壳，Web 部署形态作废 |
| Playwright/Puppeteer 接管**本机 Chrome** | ✓ | ✗（独立窗口） | 中 | 需用户以 `--remote-debugging-port` 启动浏览器；只能本机用 |
| 容器内 Chromium + **CDP screencast** | ✓ | ✓（帧流） | 中 | 视频/音频体验差、有输入延迟；实现输入回传（鼠标/键盘） |
| 容器内 Chromium + **noVNC** | ✓ | ✓✓ | 中 | 镜像大、延迟高；本项目自建一套（发布 6080，与 NAS 上既有的另一个 novnc 容器 8888 无关） |

**建议路线**：

1. **MVP 先用"接管本机 Chrome"**——`chromium --remote-debugging-port=9222`，后端用 `chrome-remote-interface` / Playwright `connectOverCDP` 接管标签页。零额外镜像，逻辑先跑通。
2. **产品化再做 screencast 内嵌**——`Page.startScreencast` 拿 JPEG 帧推给前端 `<canvas>`，`Input.dispatchMouseEvent/KeyEvent` 回传点击。比 noVNC 轻，不需要 X 服务；代价是视频播不动（对本场景够用，我们要的是请求列表不是观影）。
3. noVNC 作为兜底：现成容器，兼容性最好，但体验最重。

> iframe 方案可以直接排除：既拿不到请求明细，还会被一半的站点拒绝。

### 2.3 采集口径：什么算"慢"、什么算"超时"

CDP 提供的事件与字段：

| 事件 | 用途 |
|---|---|
| `Network.requestWillBeSent` | 请求发起（url、type、frameId、initiator） |
| `Network.responseReceived` | 拿到响应头，含 `response.timing`（`requestTime` / `sendStart` / `sendEnd` / `receiveHeadersEnd`） |
| `Network.loadingFinished` | 完成，含 `timestamp`、`encodedDataLength` |
| `Network.loadingFailed` | 失败，含 `errorText`（`net::ERR_TIMED_OUT`）、`blockedReason`、`canceled` |

判定建议（双阈值，避免"下载大文件"被误判）：

```
TTFB      = response.receiveHeadersEnd - request.timing.requestTime      // 首字节
TOTAL     = loadingFinished.timestamp - requestWillBeSent.timestamp      // 总耗时
SLOW      = TTFB > 5000ms  ||  TOTAL > 5000ms
TIMEOUT   = loadingFailed.errorText 命中 ERR_TIMED_OUT / ERR_CONNECTION_RESET / ERR_NAME_NOT_RESOLVED
CACHED    = response.fromDiskCache || fromMemoryCache → 耗时不可信，排除
```

几个必须处理的细节：

- **缓存**：开启"禁用缓存"（`Network.setCacheDisabled`），否则二次加载全部命中缓存，什么也测不出来。
- **Service Worker**：SW 拦截的请求 `timing` 为空，需标注为"无法测量"，或临时 `ServiceWorker.stopAllWorkers` 再抓一轮。
- **同 URL 多请求**：按 `(host, url)` 去重后再聚合。
- **iframe / 第三方**：CDP 能看到所有 frame 的请求，用 `frameId` 归属；跨域 iframe 也能看到。
- **SPA 懒加载**：必须"开始抓包 → 用户在页面里点几下 → 结束抓包"，不能只抓首屏。

### 2.4 聚合到域名，以及"自动去除"的安全边界

hosts / 规则都是**域名级**的，所以最终产物一定是"域名清单"，不是"URL 清单"。按 host 聚合：

| 指标 | 说明 |
|---|---|
| 请求数 / 失败数 | |
| p50 / p95 TTFB、总耗时 | 用 p95 而不是平均值，避免被一个慢请求带偏 |
| 资源类型分布 | script / xhr / img / document |
| 是否第一方 | 与页面主域 eTLD+1 比较 |
| 传输字节 | 判断是不是"慢但必须"（比如大图） |

**关键判断：慢 ≠ 可以删。**

同一份"慢"数据，处理方式完全不同：

| 情况 | 建议动作 | 理由 |
|---|---|---|
| 第三方 + 广告/统计 + 慢或失败 | 屏蔽 | 本来就是可选项，堵掉提升最明显 |
| 第三方 + 关键资源（CDN 上的 JS/CSS）+ 慢 | 加速（换 IP） | 换到快边缘节点即可，保留功能 |
| 第一方 + 慢 | 加速，不建议屏蔽 | 屏蔽等于站点残废 |
| 第一方 + 超时 | 只提示，不动手 | 可能是自身服务端问题，改 hosts 无解 |
| 慢但可用 + SNI 阻断 | 提示"需代理" | 改 hosts 无效，这是本项目一直强调的 |

因此**"自动去除"应实现为"自动标记 + 默认勾选策略"**：

- 默认勾选：第三方广告/统计类、明确超时且非第一方
- 默认不勾：第一方、document 类型、带 `script` 且站点无 fallback 的
- 提供"全选 / 反选 / 只看失败 / 只看第三方"批量操作
- 每个域名旁给一行"为什么建议屏蔽"的依据（p95 耗时、失败次数、类型）

页面上直接删 DOM 节点（`element.remove()`）技术上可行，但只对当次页面有效，刷新即失效，且会掩盖问题，不建议做。

### 2.5 交互流程（界面草案）

抓包卡片：

```
[ 目标网址 ______________ ]  [ 开始抓包 ]  [ 停止 ]   状态：捕获中 · 128 个请求
┌──────────────────────────────────────────────────────────────────┐
│ ☑ 全选   筛选：全部 / 慢(>5s) / 失败 / 第三方      排序：耗时↓    │
├──┬────────────────────┬──────┬───────┬──────┬──────┬────────────┤
│☑ │ 域名                │ 类型 │ p95   │ 失败 │ 字节 │ 建议        │
├──┼────────────────────┼──────┼───────┼──────┼──────┼────────────┤
│☑ │ ads.example.net    │ 第三方│ 8.4s  │ 3    │ 82KB │ 屏蔽        │
│☐ │ cdn.site.com       │ 第一方│ 6.1s  │ 0    │ 1.2MB│ 加速（换IP） │
│☑ │ tracker.io         │ 第三方│ 超时  │ 5    │ —    │ 屏蔽        │
└──┴────────────────────┴──────┴───────┴──────┴──────┴────────────┘
[ 测速并加速（3） ]  [ 加入屏蔽（2） ]  [ 导出清单 ]
```

"测速并加速"直接调现有链路：`/local/probe` → 判定 → `/local/adopt`；"加入屏蔽"调 `/local/blocklist`。两者都已经做过查重与提示，不用新逻辑。

### 2.6 数据模型与接口草案

```ts
interface CaptureSession {
  id: string
  url: string
  startedAt: string
  endedAt?: string
  requests: CapturedRequest[]   // 原始明细，用于复算
}

interface CapturedRequest {
  requestId: string
  url: string
  host: string
  type: 'document' | 'script' | 'xhr' | 'img' | 'font' | 'other'
  status?: number
  ttfbMs?: number
  totalMs?: number
  bytes?: number
  failed?: boolean
  errorText?: string
  cached?: boolean
  thirdParty?: boolean
}
```

| 接口 | 说明 |
|---|---|
| `POST /local/capture/start` | `{url, disableCache}` → `{sessionId}` |
| `GET /local/capture/:id/stream` | SSE，实时推送新增请求（前端边抓边显示） |
| `POST /local/capture/:id/stop` | 结束并返回聚合报告 |
| `GET /local/capture/:id/report` | 按 host 聚合的结果 |
| `POST /local/capture/:id/apply` | `{hosts:[], action:'accel'|'block'}` |

存储：`data/capture/<id>.json`，建议保留最近 N 次（默认 20 或 7 天），避免无限增长。

### 2.7 资源开销与部署形态

| 形态 | 额外依赖 | 内存/会话 | 适用 |
|---|---|---|---|
| 接管本机 Chrome | 无 | 0（复用用户浏览器） | 单人自用、Mac/Windows |
| 容器 Chromium + screencast | +Chromium（约 400MB 镜像） | 300–500MB | 想在任何设备上用 |
| 容器 Chromium + noVNC | +Xvfb + novnc | 500MB–1GB | 要完整交互（含视频） |

NAS 上另有一个用途不同的 `novnc` 容器（8888），**不复用它**——本项目用 `theasp/novnc:latest` 自建，发布在 6080，避免两套用途互相干扰。要注意 NAS 是长期低负载设备，跑 Chromium 会明显吃内存，建议做成"用时启动、闲置自动退出"的可选 profile（`docker compose --profile capture up -d`）。

### 2.8 风险与已知坑

1. **隐私**：抓包会把用户浏览的完整域名列表落到磁盘。默认只存 host 与耗时、不存 URL 与响应体；提供"关闭即删"。
2. **安全**：内嵌浏览器意味着服务端能打开任意站点，务必保持管理端鉴权（已有），并限制只允许 http/https。
3. **反爬/风控**：部分站点检测到自动化会降级或弹验证码，抓出来的数据不代表真实浏览体验。
4. **HTTPS 证书**：CDP 不需要 MITM，能拿到 URL 与耗时，但拿不到 body；如果要看响应内容，得装 CA，复杂度与风险都上一个台阶，**不建议**。
5. **多标签页**：一次会话只盯一个 target；用户开了新标签要显式切换。
6. **"自动去除"误伤**：这是最大的产品风险。技术上"能删"，体验上"一删就白屏"。必须保留人工确认与一键撤销。

---

## 3. 方案二：生成 Clash / mihomo 规则

### 3.1 结论：可行，且已实测

用一个临时 mihomo 容器（`metacubex/mihomo:latest`）验证了本方案依赖的两个核心机制：

```yaml
mixed-port: 17890
dns:
  enable: true
  enhanced-mode: fake-ip
  use-hosts: true
hosts:
  "accel.test.example": 192.168.6.5
rules:
  - DOMAIN-SUFFIX,blocked.test.example,REJECT
  - MATCH,DIRECT
```

实测结果（NAS 上执行，测试后容器已删除）：

| 验证项 | 命令 | 结果 |
|---|---|---|
| 域名本身不存在 | `curl http://accel.test.example:17891/` | `000`（无解析，基线） |
| hosts 加速生效 | `curl -x http://127.0.0.1:17890 http://accel.test.example:17891/` | **`200`**（被映射到 192.168.6.5 的 nginx） |
| REJECT 生效 | `curl -x ... http://blocked.test.example/` | **`502`**（代理层拒绝） |
| DNS 也走 hosts | `dig +tcp @127.0.0.1 -p 17853 accel.test.example` | **`192.168.6.5`**（`use-hosts` 生效） |

> 顺带踩到一个坑：`bind-address` / `allow-lan` 没配对时 mihomo 只监听容器内 `127.0.0.1`，`-p` 映射出来是连不上的；UDP 的 DNS 端口在 Synology 上也有映射问题，用 TCP 查询即可。

### 3.2 我们的数据 → Clash 构造

| 我们的结论 | Clash 结构 | 说明 |
|---|---|---|
| 加速域名（有 bestIp，无 SNI 阻断） | `hosts: { "github.com": ["20.205.x.x", "2606:..."] }` | 与现有 hosts 文件等价，只是注入到 mihomo 内部 |
| SNI 阻断域名 | `rules: - DOMAIN-SUFFIX,x.com,PROXY` | 改 hosts 无效，只能走代理；`PROXY` 需用户映射到自己的策略组 |
| 屏蔽域名（内置 + 手动 + 广告规则） | `rule-providers` + `RULE-SET,...,REJECT` | 域名量大（当前 990+），必须用 provider 而不是内联规则 |
| 广告规则（AWAvenue） | 同上，单独一个 provider | 便于单独开关 |

### 3.3 三种输出形态

**A. 合并片段（推荐默认）**——粘到用户已有配置里，不动他的节点：

```yaml
# ---------- custom-hosts 生成：hosts ----------
hosts:
  "github.com": ["20.205.243.166"]
  "api.github.com": ["20.205.243.168"]

# ---------- custom-hosts 生成：规则集 ----------
rule-providers:
  ch-block:
    type: http
    behavior: domain
    url: "http://192.168.6.5:8788/clash/block.yaml"
    path: ./ruleset/ch-block.yaml
    interval: 7200
  ch-proxy:
    type: http
    behavior: domain
    url: "http://192.168.6.5:8788/clash/proxy.yaml"
    path: ./ruleset/ch-proxy.yaml
    interval: 7200

# ---------- 加到 rules 最前面 ----------
rules:
  - RULE-SET,ch-block,REJECT
  - RULE-SET,ch-proxy,PROXY
  - MATCH,DIRECT
```

**B. 完整配置**——给"从零开始"的人：`dns`（`use-hosts: true`）+ `hosts` + `rule-providers` + `rules` + 占位的 `proxy-groups`。

**C. 公开端点**——`/clash/block.yaml`、`/clash/proxy.yaml`，无需鉴权（和 `/host*` 同级），交给 `rule-providers` 定时拉取。这样用户只需要粘一次片段，屏蔽清单后续自动更新。

> `hosts` 没法用 provider 动态更新（mihomo 不支持 provider 版 hosts），所以加速部分要么定期整份拉取配置，要么接受"手动更新"。这是本方案唯一的结构性妥协。

### 3.4 关键约束（必须在文档里讲清楚）

1. **只在 mihomo 内生效**：Clash 的 `hosts` 是内核自己的映射表，不是系统 `/etc/hosts`；只对走了 mihomo 的流量有效（端口模式 = 显式设了代理的程序；TUN 模式 = 全机）。
2. **`dns.use-hosts` 必须开**：否则 `hosts` 不参与解析，实测直接失效。
3. **浏览器 DoH 会绕过**：Chrome/Firefox 开启"安全 DNS"后自己解析，mihomo 的 hosts 管不到。要么关掉浏览器安全 DNS，要么用 TUN + `dns-hijack`。
4. **规则顺序**：`REJECT` 必须在 `MATCH` 之前；精确 `DOMAIN` 在 `DOMAIN-SUFFIX` 之前（虽然我们只用 SUFFIX 也够）。
5. **SNI 阻断无解**：这类域名（`gist.github.com`、`registry-1.docker.io` 等）只能 `PROXY`，不要指望 hosts。
6. **REJECT 比 0.0.0.0 更干净**：hosts 屏蔽在本机表现为"连接 0.0.0.0 失败"，Clash 的 REJECT 直接返回拒绝，不会产生无谓的连接尝试。
7. **与系统 hosts 冲突**：如果用户同时用了本项目的 hosts 文件，两者会叠加（都指向同一 IP 时无害；不一致时以系统 hosts 为准，因为它在更底层）。

### 3.5 与现有 `/host` 的分工

| 用户类型 | 推荐 |
|---|---|
| 不用代理、只要 DNS 不被污染 | 继续用 `/host`（系统 hosts） |
| 已用 mihomo / Clash Verge / FlClash | 用 `/clash/*`（规则）——屏蔽更彻底、可全机生效 |
| 两者都用 | 可以共存，注意别让 hosts 文件与 Clash hosts 指向不同 IP |

---

## 4. 组合价值：一次抓包，两种产物

真正有意思的是把两者接起来：

```
打开网页抓包 → 得到"慢/失败域名"清单 → 勾选
   ├─ 测速并加速 → 写入手动加速清单 → 同时出现在 /host 与 /clash/hosts
   └─ 加入屏蔽   → 写入手动屏蔽清单 → 同时出现在 /host_block 与 /clash/block.yaml
```

也就是说：**抓包只是入口，产物复用现有两套输出**。这避免了"抓包工具自成一套、结论无法落地"的常见问题，也是本方案相对浏览器插件（如 uBlock 的 logger）的优势——它只能拦，不能"换 IP 加速"。

---

## 5. 工作量与阶段划分

| 阶段 | 内容 | 相对工作量 | 风险 |
|---|---|---|---|
| P0 | Clash 规则输出（片段 + provider 端点 + 文档） | 小 | 低，机制已验证 |
| P1 | 抓包 MVP：接管本机 Chrome，列表 + 勾选 + 应用到现有清单 | 中 | 中，CDP 细节多但可控 |
| P2 | 聚合判定与"建议"逻辑（第三方/关键资源识别、默认勾选策略） | 中 | **高**，误伤是产品风险不是技术风险 |
| P3 | 内嵌化（screencast 或 noVNC）+ 会话存档 | 中大 | 中，性能与资源占用 |
| P4 | 扩展：sing-box / Surge 格式 | 小 | 低 |

P0 可以立刻做且收益明确：即便不做抓包，Clash 输出本身就是"把已有结论喂给更合适的载体"。

---

## 6. 待决策问题

1. **抓包跑在哪**：接管用户本机 Chrome（轻、只能本机）还是容器内 Chromium（重、随处可用）？
2. **5 秒阈值**是否固定？是否按资源类型区分（document 10s / script 5s / img 3s）？
3. **自动屏蔽的默认勾选**：默认全不选（最安全）还是按启发式预勾选（更省事但可能误伤）？
4. **Clash 输出形态**：只给合并片段，还是同时提供整份配置？
5. **是否需要 sing-box**（`route.rules` + `dns` 结构不同，但数据源一致，主要是多写一个模板）。
6. **抓包记录保留策略**：只存 host 与耗时（隐私友好），还是连 URL 一起存（便于复查）？

---

## 附：参考

- Chrome DevTools Protocol — Network domain（`requestWillBeSent` / `responseReceived.timing` / `loadingFailed`）
- mihomo 配置文档：`hosts`、`dns.use-hosts`、`rule-providers`（`behavior: domain | classical`）、`RULE-SET`
- 本项目现有实现：`server/probe.ts`（探测与 SNI 判定）、`src/services/blocklist.ts`（屏蔽清单）、`src/services/hosts.ts`（hosts 生成）
