# 代理模式流量分析：设计文档（路径 A）

> 目标：在**不改 DNS/hosts** 的前提下，通过 mihomo 代理观察**非网页流量**（App、客户端、小程序），
> 识别广告/追踪域名并接入现有屏蔽体系。
>
> 状态：**设计阶段，未实施**。所有结论都有 2026-11-22 的实测数据支撑。

## 一、范围与边界

### 做什么

1. 从 mihomo 采集连接记录（域名、端口、上下行、耗时、命中规则、走的分组）
2. 按域名聚合，识别广告/追踪
3. 识别结果进入「待确认」列表，用户确认后写入屏蔽规则
4. 屏蔽通过 mihomo 的 rule-provider 生效（复用现有 `/clash/block.yaml`）

### 明确不做

| 不做 | 原因 |
|---|---|
| HTTPS 中间人解密 | 需在每台设备装 CA；大量 App 有证书固定会直接拒绝；与项目"改 DNS 加速"的定位冲突 |
| 获取 URL 路径 | 代理只能拿到域名（实测 `metadata` 里无 path 字段），路径级识别做不到 |
| 自动写入屏蔽 | 代理模式下误杀一个域名可能导致 App 登录失败，代价远高于 hosts 误杀 |

## 二、实测事实（方案的地基）

### 2.1 现有代理层已就绪

```
mihomo v1.19.33（Clash Meta）
mixed-port: 7890    external-controller: 0.0.0.0:9090
CapAdd=[CAP_NET_ADMIN]   Devices=[/dev/net/tun]   ← 可开 TUN 做透明代理
```

`CAP_NET_ADMIN` + `/dev/net/tun` 说明**技术上支持透明代理**，设备端可不配代理直接接管流量。但本设计**不启用 TUN**（理由见 §7）。

### 2.2 `/connections` 能拿到什么

实测样本（HTTPS 连接）：

```json
{
  "metadata": {
    "host": "weapsi.market.xiaomi.com",
    "type": "HTTPS",
    "destinationPort": "443",
    "sourceIP": "192.168.6.28",
    "inboundName": "DEFAULT-MIXED",
    "sniffHost": "",          ← 空
    "remoteDestination": "203.0.113.10"
  },
  "upload": 1107,
  "download": 5779,
  "chains": ["DIRECT"],
  "rule": "RuleSet",
  "rulePayload": "direct"
}
```

**能拿到**：域名、端口、来源 IP、上下行字节、链路、命中规则。
**拿不到**：URL 路径、请求头、响应内容（`sniffHost` 为空，`metadata` 无任何 path/url 字段）。

关键结论：**HTTPS 的域名可见**（来自 CONNECT 或 SNI），这已足够做域名级广告识别。

### 2.3 现有能力可复用 —— 但有重要缺口

用 8 个样本实测 `detectAd({ host, thirdParty, url: undefined })`（模拟代理模式）：

| 域名 | 判定 | 依据 |
|---|---|---|
| ads.doubleclick.net | ✓ ad (high) | 已知广告网络 |
| ssl.google-analytics.com | ✓ track (high) | 已知追踪服务商 |
| **app-measurement.com** | **✗ 漏判** | — |
| **talkingdata.com** | **✗ 漏判** | — |
| **umeng.com** | **✗ 漏判** | — |
| api.github.com | ✓ 正常 | — |
| static.licdn.com | ✓ 正常 | — |
| weatherapi.market.xiaomi.com | ✓ 正常 | — |

**只识别出 2/8**。原因是这套逻辑为浏览器场景设计：
- `TRACKER_VENDORS` 表没收录国内统计 SDK（这是浏览器抓包里较少见的）
- 路径特征（`/banner`、`/pixel.gif`）在代理模式**完全用不上**（拿不到 URL）
- `thirdParty` 在代理模式下无从判断，传 `true`/`false` 结论完全一样

**结论：`ad-detect` 可以复用，但只能覆盖一小部分。这正是需要引入 AI 的根本原因** —— 模型能补上"没见过但语义明显"的域名（如 `app-measurement` 字面就是"应用测量"）。

同时说明：**必须先扩充 `TRACKER_VENDORS`** 收录国内统计 SDK（友盟、TalkingData、GrowingIO、神策、极光、Firebase、AppsFlyer、Adjust），这类域名量大且高度确定，不该交给模型猜。

| 组件 | 复用方式 |
|---|---|
| `server/capture/ad-detect.ts` | **零依赖纯函数**，只要 `host` 就能判；但代理模式下仅覆盖 2/8，需扩充词表 + AI 兜底 |
| 广告规则库 | 977 条（AWAvenue v1.7.9），已启用 |
| `buildDomainPayload` | 输出 mihomo 标准 rule-provider payload |
| `/clash/block.yaml`、`/clash/ads.yaml` | mihomo 定时拉取的现成通道 |
| `taskManager` | 长任务进度与轮询机制 |
| 「待确认」交互模式 | 档位 A 的 discover 面板可作参照 |

## 三、本地 AI 模型实测

服务 `http://192.168.6.195:8080`，llama.cpp + OpenAI 兼容。

### 3.1 可用模型

| 模型 | 参数 | 能力 |
|---|---|---|
| `qwen35-4b` | 4.33B Q4_K_M，上下文 65536 | 对话、思考、工具调用，约 30 tok/s |
| `glm-ocr` | 0.89B Q8_0 | 仅 OCR，本方案用不到 |

### 3.2 关键发现：必须关闭 thinking

同一个请求，两种参数差异巨大：

| 参数 | 耗时 | 输出 token | 结果 |
|---|---|---|---|
| 默认（thinking 开） | 3.0s | 380 | `content` 为空（思考耗尽预算） |
| `enable_thinking: false` | **0.5s** | **7** | `{"isAd":true}` |

`max_tokens=80` 时思考过程会吃掉全部预算，`content` 返回空字符串。**这是必须写进实现的坑**。

参数位置：

```json
{"chat_template_kwargs": {"enable_thinking": false}}
```

### 3.3 判定准确性：有盲区，必须规则库兜底

单域名判定实测（原始提示词）：

| 域名 | 模型判定 | 实际 | 结论 |
|---|---|---|---|
| ads.doubleclick.net | ad | ad | ✓ |
| ssl.google-analytics.com | track | track | ✓ |
| app-measurement.com | track | track | ✓ |
| api.github.com | normal | normal | ✓ |
| static.licdn.com | normal | normal | ✓ |
| **talkingdata.com** | **normal** | track | ✗ |
| **umeng.com** | **normal** | track | ✗ |

**模型不认识国内统计 SDK**。加入背景知识后两个都判对了：

```
system: "...注意中文统计SDK：友盟umeng、TalkingData、GrowingIO、神策、极光均属track..."
```

结论：**提示词必须内置国内常见追踪服务商知识**，且仍需规则库（977 条）优先。

### 3.4 批量判定显著优于逐个

一次请求判 8 个域名：

```
耗时 7.79s，输出 207 tokens，8/8 全部判对（含 umeng）
```

对比逐个判定（0.5s × 8 = 4s，但受并发限制实际更慢）。

### 3.5 并发能力

干净环境压测（每次独立文件名）：

| 并发 | HTTP 200 | 耗时 |
|---|---|---|
| 8 | 6/8 | 3.4s |
| 16 | 6/16 | 2.9s |
| 32 | 25/32 | 14.6s |

失败表现是 `curl` 返回 `000`（连接被拒/超时），**不是应用层错误**，说明是模型服务的承载上限。

结论：**并发不要超过 4**，靠批量（每批 8~10 个域名）提升吞吐，而不是靠并发。

### 3.6 结构化输出用 JSON Schema

`response_format.json_schema` 生效，输出干净（无 markdown 围栏）：

```json
{"domain": "ads.doubleclick.net", "type": "ad", "confidence": 0.99}
```

若不指定，模型会包一层 ` ```json ` 围栏，需要容错解析。**建议用 schema**。

## 四、架构设计

```
┌──────────────┐   /connections (轮询)   ┌──────────────────┐
│   mihomo     │ ──────────────────────> │  proxy-collector │
│  :9090       │                          │  按域名聚合       │
└──────────────┘                          └────────┬─────────┘
       ▲                                           │
       │ rule-provider 定时拉取                      │ 候选域名
       │                                           ▼
┌──────┴───────┐                          ┌──────────────────┐
│ block.yaml   │ <──── 确认写入 ────────  │   识别流水线      │
│ ads.yaml     │                          │  ① 规则库匹配     │
└──────────────┘                          │  ② 复用 ad-detect │
                                          │  ③ AI 兜底判定    │
                                          └────────┬─────────┘
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │ 「待确认」列表    │
                                          │ 用户勾选 → 写入   │
                                          └──────────────────┘
```

### 4.1 采集层

**方式**：轮询 `GET /connections`（带 Bearer secret），间隔 5s。

**为什么不用 WebSocket**：`/connections` 是快照，连接断开即消失。5s 轮询足以捕获多数连接；WebSocket 虽实时但实现复杂、断线重连要处理，收益不明显。

**聚合规则**：以 `host` 为 key，累积
- `connections`（出现次数）
- `upload` / `download` 累计
- `chains`（走 DIRECT 还是代理）
- `firstSeen` / `lastSeen`

**过滤**：跳过空 host（纯 IP 连接）、跳过 `localhost`/内网段。

### 4.2 识别层（三档，优先级从高到低）

| 档 | 依据 | 强度 | 是否建议屏蔽 |
|---|---|---|---|
| ① | 命中 977 条广告规则库 | `high` | 是 |
| ② | 命中内置追踪服务商表（`TRACKER_VENDORS`） | `high` | 是 |
| ③ | 域名特征（`ads.` 前缀、`analytics`/`track` 词 + 第三方特征） | `medium` | 是 |
| ④ | AI 判定为 `ad`/`track` 且 `confidence >= 0.8` | `medium` | 是 |
| ⑤ | AI 判定但置信度 < 0.8 | `low` | 否，仅展示 |

**关键**：AI 只做兜底（④⑤），前两档命中就不必调模型 —— 省算力，也避免模型误判覆盖确定答案。

**为什么必须有 AI**：实测 `ad-detect` 在代理模式只识别 2/8（§2.3）。漏掉的 `app-measurement.com`、
`umeng.com`、`talkingdata.com` 都是确定无疑的追踪域名，但不在任何内置表里。
扩充词表能解决大部分，剩下"没见过但语义明显"的就靠模型。

### 4.3 第三方判定（代理模式下的难点）

hosts/浏览器模式有"页面主机"做参照，代理模式**没有**。三种替代信号：

1. `chains` 含代理节点（非 DIRECT）→ 说明该域名被规则判定为需代理，通常不是国内正常业务
2. 域名后缀与来源 App 无关 → 但代理拿不到 App 包名（`metadata.process` 为空）
3. 域名出现在多个不同来源 IP 的连接里 → 可能是公共追踪服务

**建议**：先不做第三方判定，改为在界面上展示 `chains` 和流量，让人自己判断。这比用不可靠的信号自动判定更安全。

### 4.4 AI 调用设计

**批量**：每批 **8 个域名**，一次请求。

**参数**：
```json
{
  "model": "qwen35-4b",
  "temperature": 0,
  "max_tokens": 500,
  "chat_template_kwargs": {"enable_thinking": false},
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ad_judge",
      "strict": true,
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "domain": {"type": "string"},
            "type": {"type": "string", "enum": ["ad", "track", "sdk", "normal"]},
            "confidence": {"type": "number"}
          },
          "required": ["domain", "type", "confidence"]
        }
      }
    }
  }
}
```

**system 提示词**（内置国内服务商知识，这是实测出来的必需品）：

```
你是移动应用流量分析专家。判断域名用途：
ad=广告投放  track=数据统计/用户追踪  sdk=第三方SDK  normal=业务接口或内容分发

注意：以下属 track —— 友盟umeng、TalkingData、GrowingIO、神策sensors、
极光jpush、app-measurement、google-analytics、firebase、facebook pixel
以下属 ad —— doubleclick、googlesyndication、adservice、criteo、taboola、
outbrain、applovin、unityads、vungle、chartboost、inmobi

只输出 JSON 数组，不要解释。
```

**并发与超时**：并发 2，单请求超时 60s，失败重试 1 次。

**降级**：模型不可达时跳过 ④⑤ 两档，只用规则库 + 域名特征，并在界面明确标注"AI 判定不可用"。

### 4.5 缓存

AI 判定结果按域名缓存（`data/ai-ad-cache.json`），有效期 30 天。

- 同一域名不会重复问模型（4B 模型判同一域名结果稳定，重复问纯浪费）
- 命中缓存的域名直接出结论，实测 30 个域名首次约 4 批 × 8s = 32s，二次为 0

### 4.6 生效层（复用现有）

屏蔽写入 → `addBlocked()` → 自动出现在 `/clash/block.yaml` → mihomo 定时拉取 → 命中即 REJECT。

**不用改 mihomo 配置**，只要确认它的 `rule-providers` 已指向这两个 URL。实测 mihomo 配置里目前**没有任何 custom-hosts 相关规则**，需要用户手动加：

```yaml
rule-providers:
  custom-hosts-block:
    type: http
    behavior: domain
    url: "http://192.168.6.5:8788/clash/block.yaml"
    path: ./ruleset/custom-hosts-block.yaml
    interval: 3600

rules:
  - RULE-SET,custom-hosts-block,REJECT
```

这一步是**前置条件**，不做的话写了规则也不生效。

## 五、数据结构

```ts
/** 一次采集会话 */
interface ProxySession {
  id: string                    // proxy-<ts>-<rand>
  startedAt: string
  endedAt?: string
  status: 'running' | 'stopped'
  /** 累计连接数（含已断开的） */
  totalConnections: number
}

/** 按域名聚合 */
interface ProxyHostStat {
  host: string
  connections: number           // 出现次数
  upload: number                // 累计上行字节
  download: number              // 累计下行字节
  chains: string[]              // 走过的链路（去重）
  rules: string[]               // 命中的规则（去重）
  firstSeen: string
  lastSeen: string
  /** 识别结果 */
  ad?: {
    isAd: boolean
    strength: 'high' | 'medium' | 'low'
    source: 'rule' | 'vendor' | 'pattern' | 'ai'
    signals: string[]
    confidence?: number         // 仅 AI 有
  }
}
```

## 六、界面设计

新增独立标签页「代理观察」，与现有「网页诊断」并列。

```
┌─ 代理观察 ─────────────────────────────────────┐
│ 状态：mihomo 已连接 · 采集 12 分钟 · 87 个域名   │
│ [开始采集] [停止]  [AI 识别]  [清空]            │
│                                                 │
│ 筛选：[✓]广告 [✓]追踪 [ ]SDK [✓]正常  [只看未处理]│
│                                                 │
│ ☐ 域名              连接  下行   链路   识别  │
│ ☐ ads.foo.com        12   45KB  PROXY  广告   │
│ ☑ track.bar.com       3    2KB  DIRECT 追踪   │
│ ...                                             │
│                                                 │
│ [加入屏蔽(1)]  ← 只提交勾选的                    │
└─────────────────────────────────────────────────┘
```

要点：
- 采集是**独立会话**，与网页抓包互不影响
- 「AI 识别」是显式动作，不自动触发（避免用户只是开着代理就被消耗算力）
- 识别结果**只展示不自动写**，勾选后手动「加入屏蔽」

## 七、为什么不开 TUN

技术上可行（有 `CAP_NET_ADMIN` + `/dev/net/tun`），但：

1. TUN 会改变宿主机路由，**影响 NAS 上其它所有容器**
2. 用户设备需配网关/路由规则，比"配个代理"复杂
3. 显式代理（7890）已能覆盖主动配置的设备，够用

如果将来要覆盖"不配合的设备"（如电视、游戏机），再单独评估 TUN，且应在独立容器里做，不和 app 混。

## 八、实施顺序

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 采集接口 + 聚合（只读，不改任何配置） | 零 |
| 2 | 界面展示原始连接（域名/流量/链路） | 零 |
| 3 | 接入规则库 + `ad-detect` 判定 | 零 |
| 4 | 接入 AI 兜底（批量 + 缓存 + 降级） | 低（算力消耗） |
| 5 | 「加入屏蔽」写入 | 中（误杀影响 App） |
| 6 | mihomo rule-provider 配置（**用户手动**） | 中（改代理配置） |

**1~3 步完全不改变任何现有行为**，纯增量观察，可以先跑一段时间积累样本，再决定要不要做 4~6。

## 九、已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误杀导致 App 异常 | 用户登录失败/功能不可用 | 只建议不自动写；确认前展示域名、流量、链路 |
| 模型判定不准 | 漏判/误判 | 规则库优先，AI 只兜底；置信度 <0.8 不建议 |
| 模型服务不稳定 | 采集卡住 | 并发限 2、超时 60s、失败降级为仅规则判定 |
| 连接快照丢数据 | 短连接捕获不到 | 5s 轮询 + 长周期采集；接受部分丢失 |
| 流量数据量大 | 内存增长 | 按域名聚合而非存原始连接；单会话上限 5000 域名 |

## 十、与现有功能的关系

| 现有功能 | 关系 |
|---|---|
| 网页抓包（CDP） | **互补**：网页走 CDP（能拿到 URL 和路径），非网页走代理（只有域名） |
| `ad-detect.ts` | **直接复用**，`url` 传 `undefined` |
| 档位 A（发现待加速） | 思路一致：都是"发现 → 建议 → 人工确认" |
| hosts 屏蔽输出 | **共用** `addBlocked`，同一份清单，两个出口（hosts + clash yaml） |
| 预览验证 | 代理模式不适用（无法在代理里预演单域名效果） |

## 附：实测环境

- mihomo v1.19.33，`192.168.6.5:9090`（Bearer 认证）
- 本地 AI：`192.168.6.195:8080`，qwen35-4b（4.33B Q4_K_M）
- 验证时间：2026-11-22
