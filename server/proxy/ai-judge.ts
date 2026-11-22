/**
 * 本地 AI 广告判定客户端。
 *
 * 服务：llama.cpp + OpenAI 兼容（默认 192.168.6.195:8080，模型 qwen35-4b）。
 *
 * 三个实测出来的关键约束，都直接决定实现方式：
 *
 * 1. **必须关 thinking**。默认 3.0s / 380 tokens 且 content 返回空字符串
 *    （思考过程把 max_tokens 吃光了）；关掉后 0.5s / 7 tokens。
 *    参数是 chat_template_kwargs.enable_thinking = false。
 *
 * 2. **必须批量**。一次判 8 个域名只要 7.79s，逐个判要 8 次往返；
 *    而服务并发能力有限（实测 8 并发有 2 个连接被拒），
 *    靠批量比靠并发更稳。
 *
 * 3. **模型不认识国内统计 SDK**。原始提示词下 umeng.com / talkingdata.com
 *    都被判成 normal。system 里内置词表后修正。词表同时写进了
 *    ad-detect 的 TRACKER_VENDORS —— 双保险，但优先级不同：
 *    内置表命中就不调模型（省钱且确定）。
 *
 * 降级：模型不可达时返回 null，调用方退化为仅规则判定，不阻塞。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 模型给出的分类 */
export type AiCategory = 'ad' | 'track' | 'sdk' | 'normal'

export interface AiVerdict {
  domain: string
  category: AiCategory
  confidence: number
}

export interface AiJudgeConfig {
  baseUrl: string
  model: string
  /** 每批多少个域名 */
  batchSize: number
  /** 同时跑几批 */
  concurrency: number
  /** 单请求超时 */
  timeoutMs: number
}

const DEFAULTS: AiJudgeConfig = {
  baseUrl: 'http://192.168.6.195:8080',
  model: 'qwen35-4b',
  batchSize: 8,
  // 实测：8 并发就有连接被拒，32 并发只剩 6/32。靠批量提吞吐，不靠并发。
  concurrency: 2,
  timeoutMs: 60_000,
}

/**
 * system 提示词。
 *
 * 词表部分是实测必需的：不给这些名字，模型会把 umeng、talkingdata
 * 这类判成 normal。这不是"提示词优化"，是准确率的硬前提。
 */
const SYSTEM_PROMPT = `你是移动应用流量分析专家。判断给定域名的用途，分四类：
- ad：广告投放、广告网络、广告变现 SDK
- track：数据统计、用户行为追踪、归因分析、崩溃上报
- sdk：第三方功能 SDK（推送、分享、支付、地图等），非广告非统计
- normal：业务接口、内容分发、CDN、静态资源

已知归属（必须遵守）：
track —— 友盟 umeng、TalkingData、GrowingIO、神策 sensorsdata、极光 jpush/jiguang、
个推 getui/igexin、Firebase app-measurement、AppsFlyer、Adjust、Branch、Kochava、
Google Analytics、Crashlytics、Bugly、腾讯灯塔 beacon.qq.com、百度统计 hm.baidu.com、CNZZ
ad —— doubleclick、googlesyndication、googleadservices、criteo、taboola、outbrain、
applovin、unityads、vungle、chartboost、inmobi、pubmatic、rubicon

不确定时宁可给 normal 并降低 confidence，不要猜。只输出 JSON 数组。`

interface CacheEntry {
  category: AiCategory
  confidence: number
  at: string
}

/** 缓存 30 天：同一域名反复问 4B 模型结果稳定，重复问纯浪费算力 */
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000

function cacheFile(): string {
  return path.resolve(process.cwd(), 'data/ai-ad-cache.json')
}

export class AiJudge {
  private readonly cfg: AiJudgeConfig
  private cache: Map<string, CacheEntry> | null = null
  private cacheDirty = false
  /** 最近一次失败原因，供界面显示 */
  lastError: string | null = null

  constructor(cfg: Partial<AiJudgeConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg }
  }

  async loadCache(): Promise<void> {
    if (this.cache) return
    this.cache = new Map()
    try {
      const raw = await fs.readFile(cacheFile(), 'utf8')
      const obj = JSON.parse(raw) as Record<string, CacheEntry>
      const now = Date.now()
      for (const [k, v] of Object.entries(obj)) {
        if (!v?.at) continue
        // 过期条目直接丢弃，避免文件无限增长
        if (now - Date.parse(v.at) > CACHE_TTL_MS) continue
        this.cache.set(k, v)
      }
    } catch {
      // 没有缓存文件是正常状态
    }
  }

  private async flushCache(): Promise<void> {
    if (!this.cacheDirty || !this.cache) return
    try {
      const file = cacheFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const obj: Record<string, CacheEntry> = {}
      for (const [k, v] of this.cache) obj[k] = v
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(obj), 'utf8')
      await fs.rename(tmp, file)
      this.cacheDirty = false
    } catch (err) {
      console.error('[ai-judge] 写入缓存失败', err)
    }
  }

  /** 服务是否可用 */
  async ping(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const d = (await res.json()) as { models?: { name?: string }[] }
      return { ok: true, models: (d.models || []).map((m) => m.name || '').filter(Boolean) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 批量判定。
   *
   * 命中缓存的直接返回，只把未命中的送去模型。
   * 模型失败时该批域名不出现在结果里（调用方按"无结论"处理）。
   */
  async judge(domains: readonly string[]): Promise<Map<string, AiVerdict>> {
    await this.loadCache()
    const out = new Map<string, AiVerdict>()
    const todo: string[] = []

    for (const d of domains) {
      const host = d.trim().toLowerCase()
      if (!host) continue
      const hit = this.cache?.get(host)
      if (hit) {
        out.set(host, { domain: host, category: hit.category, confidence: hit.confidence })
      } else {
        todo.push(host)
      }
    }

    if (!todo.length) return out

    // 切批
    const batches: string[][] = []
    for (let i = 0; i < todo.length; i += this.cfg.batchSize) {
      batches.push(todo.slice(i, i + this.cfg.batchSize))
    }

    let cursor = 0
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor]
        cursor += 1
        try {
          const rows = await this.judgeBatch(batch)
          for (const r of rows) {
            if (!batch.includes(r.domain)) continue // 模型可能改写域名，丢弃对不上的
            out.set(r.domain, r)
            this.cache?.set(r.domain, {
              category: r.category,
              confidence: r.confidence,
              at: new Date().toISOString(),
            })
            this.cacheDirty = true
          }
          this.lastError = null
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err)
          console.error('[ai-judge] 批次失败', this.lastError)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(this.cfg.concurrency, batches.length) }, worker),
    )
    await this.flushCache()
    return out
  }

  /** 判一批。用 json_schema 强制结构化，省掉剥 markdown 围栏的麻烦 */
  private async judgeBatch(batch: readonly string[]): Promise<AiVerdict[]> {
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: batch.join('\n') },
      ],
      temperature: 0,
      max_tokens: 600,
      // 实测必需：不关 thinking 会耗尽 max_tokens 导致 content 为空
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ad_judge',
          strict: true,
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                category: { type: 'string', enum: ['ad', 'track', 'sdk', 'normal'] },
                confidence: { type: 'number' },
              },
              required: ['domain', 'category', 'confidence'],
              additionalProperties: false,
            },
          },
        },
      },
    }

    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
    const d = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = d.choices?.[0]?.message?.content || ''
    return parseVerdicts(content)
  }
}

/**
 * 解析模型输出。
 *
 * 即便用了 json_schema，也不假设格式完美：模型偶尔会包 ```json 围栏，
 * 或者把顶层包成 {items:[...]}。宁可多一层容错，也不要整批丢弃。
 */
export function parseVerdicts(raw: string): AiVerdict[] {
  const text = (raw || '').trim()
  if (!text) return []

  const candidates: string[] = [text]
  // 剥 markdown 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())
  // 截取最外层数组
  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1))
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown }).items)
          ? (parsed as { items: unknown[] }).items
          : null
      if (!arr) continue
      const out: AiVerdict[] = []
      for (const it of arr) {
        const row = it as { domain?: unknown; category?: unknown; confidence?: unknown }
        const domain = typeof row.domain === 'string' ? row.domain.trim().toLowerCase() : ''
        const category = row.category
        if (!domain) continue
        if (category !== 'ad' && category !== 'track' && category !== 'sdk' && category !== 'normal') {
          continue
        }
        const conf = typeof row.confidence === 'number' ? row.confidence : Number(row.confidence)
        out.push({
          domain,
          category,
          // 缺置信度时给 0.5：既不当作高可信，也不直接丢弃
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
        })
      }
      if (out.length) return out
    } catch {
      // 换下一个候选
    }
  }
  return []
}
