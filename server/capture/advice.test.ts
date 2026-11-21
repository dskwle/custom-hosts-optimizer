import test from 'node:test'
import assert from 'node:assert/strict'

// @ts-ignore TS5097 —— node --experimental-strip-types 只认显式 .ts 后缀；tsconfig 未开 allowImportingTsExtensions
import { advise, adviseAll, summarize } from './advice.ts'
// @ts-ignore TS5097 同上
import { aggregate } from './aggregate.ts'
import type { CapturedRequest, HostSummary, RequestKind, Verdict } from './types'

let seq = 0
function req(host: string, kind: RequestKind, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  seq += 1
  return { requestId: `r-${seq}`, host, kind, ...extra }
}

/** 构造一个只有一条请求的 summary，便于单点验证规则 */
function one(host: string, kind: RequestKind, extra: Partial<CapturedRequest>, pageHost = 'www.example.com'): HostSummary {
  const [summary] = aggregate([req(host, kind, extra)], pageHost)
  return summary
}

test('无异常域名 → unknown，不建议勾选', () => {
  const advice = advise(one('cdn.example.net', 'script', { ttfbMs: 120, totalMs: 220 }))
  assert.equal(advice.verdict, 'unknown')
  assert.equal(advice.suggested, false)
  assert.match(advice.reason, /未见异常/)
})

test('第三方 + 失败 → block 且默认勾选', () => {
  const advice = advise(
    one('tracker.adnetwork.com', 'img', { failed: true, errorText: 'net::ERR_TIMED_OUT' }),
  )
  assert.equal(advice.verdict, 'block')
  assert.equal(advice.suggested, true)
  assert.match(advice.reason, /第三方域名 1 个请求中 1 个失败/)
})

test('第三方 + 慢（>5s）→ accel 且默认勾选，reason 带具体秒数', () => {
  const advice = advise(one('ads.doubleclick.net', 'script', { ttfbMs: 8400, totalMs: 8600 }))
  assert.equal(advice.verdict, 'accel')
  assert.equal(advice.suggested, true)
  assert.match(advice.reason, /第三方脚本 p95 8\.6s，超过 5s/)
})

test('第三方慢但只慢在总耗时也算 accel', () => {
  const advice = advise(one('cdn.taboola.com', 'media', { ttfbMs: 300, totalMs: 6200 }))
  assert.equal(advice.verdict, 'accel')
  assert.equal(advice.suggested, true)
})

test('第一方 + 慢 → ignore，reason 说明改 hosts 可能无解', () => {
  const advice = advise(one('stream.example.com', 'media', { ttfbMs: 8200, totalMs: 8400 }))
  assert.equal(advice.verdict, 'ignore')
  assert.equal(advice.suggested, false)
  assert.match(advice.reason, /第一方/)
  assert.match(advice.reason, /改 hosts 可能无解/)
})

test('第一方 + 失败 → ignore，不许动 hosts', () => {
  const advice = advise(one('api.example.com', 'xhr', { failed: true, errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
  assert.equal(advice.verdict, 'ignore')
  assert.equal(advice.suggested, false)
  assert.match(advice.reason, /需排查源站/)
})

test('第三方同时失败又慢 → block 优先于 accel', () => {
  const advice = advise(
    one('ads.doubleclick.net', 'script', { ttfbMs: 9000, totalMs: 9300, failed: true, errorText: 'net::ERR_TIMED_OUT' }),
  )
  assert.equal(advice.verdict, 'block')
  assert.match(advice.reason, /1 个失败，p95 9\.3s/)
})

test('ctx.sniBlocked 强制 proxy，覆盖 block/accel 判定且不勾选', () => {
  const summary = one('ads.doubleclick.net', 'script', { ttfbMs: 9000, failed: true, errorText: 'net::ERR_TIMED_OUT' })
  const advice = advise(summary, { sniBlocked: true })
  assert.equal(advice.verdict, 'proxy')
  assert.equal(advice.suggested, false)
  assert.match(advice.reason, /SNI 阻断，改 hosts 无效/)
})

test('阈值可由 slowMs 覆盖（F2 调参）', () => {
  const summary = one('cdn.example.net', 'script', { ttfbMs: 3000, totalMs: 3200 })
  assert.equal(advise(summary).verdict, 'unknown')
  assert.equal(advise(summary, { slowMs: 2000 }).verdict, 'accel')
})

test('全缓存域名 → unknown，reason 说明未测得耗时', () => {
  const [summary] = aggregate(
    [req('cdn.example.net', 'img', { cached: true }), req('cdn.example.net', 'img', { cached: true })],
    'www.example.com',
  )
  const advice = advise(summary)
  assert.equal(advice.verdict, 'unknown')
  assert.equal(advice.suggested, false)
  assert.match(advice.reason, /未测得耗时/)
})

test('零请求的 summary 不抛错', () => {
  const advice = advise({
    host: 'x.example.com',
    requests: 0,
    failures: 0,
    bytes: 0,
    thirdParty: true,
    kinds: [],
    verdict: 'unknown',
    reason: '',
    suggested: false,
  })
  assert.equal(advice.verdict, 'unknown')
  assert.equal(advice.reason, '无请求数据')
})

test('suggested 只对 block / accel 为真（不做全选式建议）', () => {
  const list = [
    req('www.example.com', 'document', { ttfbMs: 200, totalMs: 400 }),
    req('ads.doubleclick.net', 'script', { ttfbMs: 8400, totalMs: 8600 }),
    req('tracker.adnetwork.com', 'img', { failed: true, errorText: 'net::ERR_TIMED_OUT' }),
    req('stream.example.com', 'media', { ttfbMs: 9000, totalMs: 9500 }),
    req('cdn.jsdelivr.net', 'script', { ttfbMs: 180, totalMs: 240 }),
  ]
  const summaries = summarize(list, { pageHost: 'www.example.com' })
  const allowed: Verdict[] = ['block', 'accel']
  for (const s of summaries) {
    assert.equal(s.suggested, allowed.includes(s.verdict), `${s.host} (${s.verdict}) suggested 判定错误`)
    assert.ok(s.reason.length > 0, `${s.host} 缺少 reason`)
  }
  const picked = summaries.filter((s) => s.suggested).map((s) => s.host).sort()
  assert.deepEqual(picked, ['ads.doubleclick.net', 'tracker.adnetwork.com'])
})

test('summarize 一步完成聚合与建议，且不修改输入', () => {
  const list = [req('ads.doubleclick.net', 'script', { ttfbMs: 8400, totalMs: 8600 })]
  const snapshot = JSON.stringify(list)
  const [summary] = summarize(list, { pageHost: 'www.example.com' })
  assert.equal(summary.thirdParty, true)
  assert.equal(summary.verdict, 'accel')
  assert.equal(summary.suggested, true)
  assert.equal(JSON.stringify(list), snapshot)
})

test('adviseAll 保持输入顺序，返回新对象', () => {
  const summaries = aggregate(
    [
      req('a.example.com', 'script', { ttfbMs: 100 }),
      req('ads.doubleclick.net', 'script', { ttfbMs: 8400 }),
    ],
    'a.example.com',
  )
  const advised = adviseAll(summaries)
  assert.equal(advised.length, 2)
  assert.deepEqual(advised.map((s) => s.host), summaries.map((s) => s.host))
  assert.notEqual(advised[0], summaries[0])
})