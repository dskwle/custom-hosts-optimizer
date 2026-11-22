/**
 * 识别编排单测。
 *
 * 核心验证"分层不互相覆盖"：
 *   - 规则库判 ad，模型判 normal 也不能翻案
 *   - 规则库命中就不该调用 AI（省算力）
 *   - AI 失败时退化为仅规则判定，不抛错
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  judgeLocal,
  fromAi,
  judgeHosts,
  parseAdRuleDomains,
  AI_MIN_CONFIDENCE,
} from './judge-pipeline.ts'
import type { AiJudge, AiVerdict } from './ai-judge.ts'

const knownAds = new Set(['doubleclick.net', '1rtb.com'])

test('规则库命中 → source=rule，high', () => {
  const v = judgeLocal('ad.doubleclick.net', knownAds)
  assert.ok(v)
  assert.equal(v.isAd, true)
  assert.equal(v.strength, 'high')
  assert.equal(v.source, 'rule')
})

test('内置服务商表命中 → source=vendor', () => {
  const v = judgeLocal('umeng.com', knownAds)
  assert.ok(v)
  assert.equal(v.isAd, true)
  assert.equal(v.source, 'vendor')
})

test('本地判不出时返回 null（交给 AI）', () => {
  assert.equal(judgeLocal('weatherapi.market.xiaomi.com', knownAds), null)
})

test('正常域名也返回 null（不误判）', () => {
  assert.equal(judgeLocal('api.github.com', knownAds), null)
})

test('parseAdRuleDomains 解析 hosts 格式并跳过注释/IP', () => {
  const set = parseAdRuleDomains(
    ['# 注释', '0.0.0.0 ads.foo.com', ':: ads.bar.com', '0.0.0.0 1.2.3.4', '', 'plain.com'].join('\n'),
  )
  assert.ok(set.has('ads.foo.com'))
  assert.ok(set.has('ads.bar.com'))
  assert.ok(set.has('plain.com'))
  assert.ok(!set.has('1.2.3.4'), '纯 IP 不该进集合')
  assert.ok(!set.has('# 注释'))
})

test('AI 判 ad 且置信度够 → 建议屏蔽', () => {
  const v = fromAi({ domain: 'x.com', category: 'ad', confidence: 0.95 })
  assert.equal(v.isAd, true)
  assert.equal(v.strength, 'medium')
  assert.equal(v.source, 'ai')
})

test('AI 判 track 且置信度高 → 建议屏蔽', () => {
  const v = fromAi({ domain: 'x.com', category: 'track', confidence: 0.9 })
  assert.equal(v.isAd, true)
})

test('AI 判 ad 但置信度低 → 不建议屏蔽，但保留线索', () => {
  const v = fromAi({ domain: 'x.com', category: 'ad', confidence: 0.5 })
  assert.equal(v.isAd, false)
  assert.equal(v.strength, 'low')
  assert.match(v.signals[0], /低于阈值/)
})

test('AI 判 normal 不建议屏蔽', () => {
  const v = fromAi({ domain: 'x.com', category: 'normal', confidence: 0.99 })
  assert.equal(v.isAd, false)
})

test('AI 判 sdk 不建议屏蔽（推送/支付等是正常功能）', () => {
  const v = fromAi({ domain: 'sdk.huawei.com', category: 'sdk', confidence: 0.95 })
  assert.equal(v.isAd, false)
})

/** 假 AI：记录被问了哪些域名，返回预设结果 */
function fakeAi(map: Record<string, AiVerdict>, fail = false): AiJudge & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    lastError: fail ? 'mock failure' : null,
    async judge(domains: readonly string[]) {
      asked.push(...domains)
      if (fail) throw new Error('mock failure')
      const out = new Map<string, AiVerdict>()
      for (const d of domains) if (map[d]) out.set(d, map[d])
      return out
    },
  } as unknown as AiJudge & { asked: string[] }
}

test('规则库命中的域名不会去问 AI', async () => {
  const ai = fakeAi({})
  await judgeHosts(['ad.doubleclick.net', 'umeng.com', 'unknown.com'], knownAds, ai, { useAi: true })
  assert.deepEqual(ai.asked, ['unknown.com'], '只应问本地判不出的那个')
})

test('规则库判 ad，AI 判 normal 也不翻案', async () => {
  const ai = fakeAi({ 'ad.doubleclick.net': { domain: 'ad.doubleclick.net', category: 'normal', confidence: 0.9 } })
  const r = await judgeHosts(['ad.doubleclick.net'], knownAds, ai, { useAi: true })
  const v = r.verdicts.get('ad.doubleclick.net')!
  assert.equal(v.isAd, true)
  assert.equal(v.source, 'rule')
  assert.deepEqual(ai.asked, [], '不该问')
})

test('useAi=false 时不调用 AI', async () => {
  const ai = fakeAi({})
  const r = await judgeHosts(['unknown.com'], knownAds, ai, { useAi: false })
  assert.deepEqual(ai.asked, [])
  assert.equal(r.verdicts.get('unknown.com')!.source, 'none')
})

test('AI 失败时退化为仅规则判定，不抛错', async () => {
  const ai = fakeAi({}, true)
  const r = await judgeHosts(['unknown.com', 'umeng.com'], knownAds, ai, { useAi: true })
  assert.equal(r.aiUsed, false)
  assert.ok(r.aiError)
  // 本地能判的仍然有结论
  assert.equal(r.verdicts.get('umeng.com')!.isAd, true)
  // 本地判不出的标记为 none
  assert.equal(r.verdicts.get('unknown.com')!.source, 'none')
})

test('统计各来源命中数', async () => {
  const ai = fakeAi({ 'aiaid.com': { domain: 'aiaid.com', category: 'ad', confidence: 0.95 } })
  const r = await judgeHosts(
    ['ad.doubleclick.net', 'umeng.com', 'aiaid.com', 'normal.com'],
    knownAds,
    ai,
    { useAi: true },
  )
  assert.equal(r.stats.rule, 1)
  assert.equal(r.stats.vendor, 1)
  assert.equal(r.stats.ai, 1)
  assert.equal(r.stats.none, 1)
})

test('limit 限制处理数量', async () => {
  const ai = fakeAi({})
  const r = await judgeHosts(['a.com', 'b.com', 'c.com'], knownAds, ai, { useAi: false, limit: 2 })
  assert.equal(r.verdicts.size, 2)
})

test('AI 阈值常量是 0.8', () => {
  assert.equal(AI_MIN_CONFIDENCE, 0.8)
})
