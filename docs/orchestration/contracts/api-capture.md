# 接口契约：抓包诊断（T0-1，已冻结）

> 变更流程：任何字段增删改，必须先改本文件并由主 agent 批准，再广播给受影响的 lane。
> 子 agent 不得在实现里"顺手"改字段名——契约不一致一律 P0。

---

## 1. 类型定义

放在 `server/capture/types.ts`（B 负责创建，C/D 只读引用；也可各自复制一份只读副本，以本文件为准）。

```ts
export type CaptureStatus = 'starting' | 'running' | 'stopped' | 'failed'

export type RequestKind =
  | 'document' | 'script' | 'xhr' | 'img' | 'font' | 'media' | 'other'

export interface CaptureSession {
  id: string                 // capture-<ts>-<rand>
  url: string                // 用户输入的起始地址
  status: CaptureStatus
  startedAt: string          // ISO
  endedAt?: string
  requestCount: number
  hostCount: number
  error?: string             // status=failed 时的原因
}

export interface CapturedRequest {
  requestId: string
  host: string               // 小写，去掉端口
  url?: string               // 仅 storeUrls=true 时返回
  kind: RequestKind
  status?: number            // HTTP 状态码，失败时缺省
  ttfbMs?: number            // 首字节；缓存命中或无法测量时为 undefined
  totalMs?: number           // 请求发起到完成
  bytes?: number
  failed?: boolean
  errorText?: string         // net::ERR_TIMED_OUT 等
  cached?: boolean           // fromDiskCache / fromMemoryCache
  frameId?: string
}

export type Verdict = 'accel' | 'block' | 'proxy' | 'ignore' | 'unknown'

export interface HostSummary {
  host: string
  requests: number
  failures: number
  p50TtfbMs?: number
  p95TtfbMs?: number
  p95TotalMs?: number
  bytes: number
  thirdParty: boolean
  kinds: RequestKind[]       // 出现过的类型，去重
  verdict: Verdict
  reason: string             // 一句话依据，给用户看，中文
  suggested: boolean         // 默认是否勾选
}

export interface CaptureEnv {
  cdp: boolean               // CDP 是否可达
  version?: string           // Chromium / Chrome 版本
  chromium?: string          // 容器内浏览器标识，便于排查
  error?: string
}
```

### 判定口径（C 实现，D 只展示）

```
SLOW    = ttfbMs > 5000 || totalMs > 5000
TIMEOUT = failed && /ERR_TIMED_OUT|ERR_CONNECTION_(RESET|REFUSED|ABORTED)|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE/
CACHED  = cached === true   → ttfb/total 不参与统计，单独计数
p95     = 对排序后的耗时取 95% 分位（不足 1 条时返回该值）
```

---

## 2. REST 接口（均需管理端鉴权，Basic Auth）

前缀：`/local/capture`

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/env` | — | `CaptureEnv` |
| POST | `/start` | `{url: string, storeUrls?: boolean}` | `{session: CaptureSession}`；失败 `400/502 {error}` |
| GET | `/?limit=20` | — | `{sessions: CaptureSession[]}`（按 startedAt 倒序） |
| GET | `/:id` | — | `{session: CaptureSession, requests: CapturedRequest[]}` |
| GET | `/:id/summary` | — | `{sessionId: string, hosts: HostSummary[]}` |
| POST | `/:id/stop` | — | `{session: CaptureSession}` |
| GET | `/:id/stream` | — | SSE，见 §3 |
| POST | `/apply` | `{hosts: string[], action: 'accel' \| 'block'}` | `{added: string[], skipped: {domain,reason}[], failed: {domain,error}[]}` |

错误约定：

| 场景 | 状态码 | body |
|---|---|---|
| 未鉴权 | 401 | `{error: "需要登录"}` |
| 参数缺失/非法 URL | 400 | `{error: "..."}` |
| CDP 不可达 | 502 | `{error: "Chromium 未就绪（CDP 连接失败）"}` |
| 会话不存在 | 404 | `{error: "session not found"}` |
| 会话已在运行又 start | 409 | `{error: "已有抓包会话在运行"}` |

`apply` 语义：内部复用现有 `/local/adopt` 与 `/local/blocklist` 的判断，
返回结构与它们保持一致（已存在/已内置/已屏蔽都算 skipped，不算失败）。

---

## 3. SSE 格式

`text/event-stream`，每帧一行 `data: <json>`，事件类型用字段区分：

```jsonc
{"type":"state","session":{"id":"capture-...","status":"running"}}
{"type":"request","request":{"requestId":"...","host":"ads.example.net","kind":"script","ttfbMs":8123,"totalMs":8401,"failed":false}}
{"type":"error","message":"页面导航失败：net::ERR_NAME_NOT_RESOLVED"}
{"type":"end","sessionId":"capture-..."}
```

约定：

- `state` 至少推送两次：`running` 与 `stopped`
- `request` 每捕获一个请求推一次（可节流到 100ms 合并多条，但字段结构不变）
- 客户端重连：服务端每次重连**只推增量**，不重放历史；前端重连后调 `/summary` 补全
- 连接空闲 15s 发送注释行 `: ping` 保活

---

## 4. 公开端点（无需鉴权，与 `/host*` 同级）

| 路径 | 内容 | 用途 |
|---|---|---|
| `/clash/hosts.yaml` | `hosts:` 映射（domain → [ip, ...]） | 加速 |
| `/clash/block.yaml` | rule-provider payload（domain 列表） | 屏蔽（自定义 + 内置） |
| `/clash/ads.yaml` | rule-provider payload（广告规则） | 屏蔽（可单独开关） |
| `/clash/proxy.yaml` | rule-provider payload（SNI 阻断域名） | 交给用户映射 PROXY |
| `/clash/snippet.yaml` | 可直接粘的合并片段 | 一键使用 |

格式约定：

```yaml
# /clash/block.yaml
payload:
  - 'ads.example.net'
  - 'tracker.io'
```

`behavior: domain` 要求 payload 为域名列表（不带类型前缀）；如需要混合类型才用 `classical`。

---

## 5. 前端约定（D）

- 只允许改 `public/console.html`
- 所有接口调用走 `API` 常量前缀（与现有代码一致）
- 401 时不弹自定义提示，交给浏览器 Basic Auth（页面本身就是受保护的）
- 新增标签页 id 约定：`capture-tab`，`data-tab="capture"`；标签文案「网页诊断」
- 表格渲染必须分批（>200 行时先渲染前 200，滚动加载），避免主线程卡顿

---

## 6. Mock（供 C/D 脱网开发）

`scripts/mock-capture.mjs` 提供与上面完全一致的假接口：

```bash
node scripts/mock-capture.mjs --port 8899
# 然后前端把 API 指到 http://127.0.0.1:8899（或 D 本地临时改常量）
```

C 的 fixture 放 `server/capture/fixtures/*.json`，格式：

```json
{ "url": "https://example.com", "requests": [ /* CapturedRequest[] */ ] }
```

---

## 7. 文件所有权（重申）

| 文件 | Owner |
|---|---|
| `server/capture/types.ts`、`cdp.ts`、`session.ts`、`store.ts`、`stream.ts` | B |
| `server/capture/aggregate.ts`、`advice.ts`、`fixtures/`、`*.test.ts` | C |
| `src/clash/**` | E |
| `scripts/mock-capture.mjs` | 主 agent（已提供，勿改） |
| `server/index.ts` 挂载行 | 主 agent |
| `public/console.html` | D |

**C 的约束**：`aggregate.ts` / `advice.ts` 必须是纯函数，不引入除 `import type` 之外的跨目录依赖，
这样可以直接用 `node --experimental-strip-types` 跑单测，不需要打包。
