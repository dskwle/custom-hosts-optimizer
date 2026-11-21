import test from 'node:test'
import assert from 'node:assert/strict'

// @ts-ignore TS5097 —— node --experimental-strip-types 只认显式 .ts 后缀；tsconfig 未开 allowImportingTsExtensions
import { DEFAULT_SLOW_MS, SLOW_MS, aggregate, inferPageHost, isCached, isIpHost, isSlow, isTimeout, median, normalizeHost, percentile, registrableDomain, thirdParty } from './aggregate.ts'
import type { CapturedRequest, RequestKind } from './types'

let seq = 0
function req(host: string, kind: RequestKind, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  seq += 1
  return { requestId: `r-${seq}`, host, kind, ...extra }
}

test('空输入返回空数组', () => {
  assert.deepEqual(aggregate([]), [])
})

test('阈值常量默认 5000 且可由环境变量覆盖', () => {
  assert.equal(DEFAULT_SLOW_MS, 5000)
  // SLOW_MS 是模块加载时读取的，要么是默认值，要么是合法覆盖值
  assert.ok(SLOW_MS > 0)
})

test('按 host 聚合请求数、失败数、字节与类型集合', () => {
  const list = [
    req('a.example.com', 'script', { ttfbMs: 100, totalMs: 200, bytes: 1000 }),
    req('a.example.com', 'xhr', { ttfbMs: 300, totalMs: 400, bytes: 500 }),
    req('a.example.com', 'script', { failed: true, errorText: 'net::ERR_TIMED_OUT' }),
    req('b.example.com', 'img', { ttfbMs: 200, totalMs: 250, bytes: 800 }),
  ]
  const [a, b] = aggregate(list, 'example.com')
  assert.equal(a.host, 'a.example.com')
  assert.equal(a.requests, 3)
  assert.equal(a.failures, 1)
  assert.equal(a.bytes, 1500)
  assert.deepEqual(a.kinds, ['script', 'xhr'])
  assert.equal(a.thirdParty, false)
  assert.equal(b.requests, 1)
  assert.deepEqual(b.kinds, ['img'])
})

test('缓存请求计入请求数但不参与耗时统计', () => {
  const list = [
    req('cdn.example.com', 'script', { ttfbMs: 100, totalMs: 120 }),
    req('cdn.example.com', 'script', { cached: true, ttfbMs: 9000, totalMs: 9500, bytes: 4000 }),
  ]
  const [summary] = aggregate(list, 'example.com')
  assert.equal(summary.requests, 2)
  assert.equal(summary.p50TtfbMs, 100)
  assert.equal(summary.p95TtfbMs, 100)
  assert.equal(summary.p95TotalMs, 120)
  assert.equal(summary.bytes, 4000) // 缓存请求的资源体积仍计入
})

test('全部缓存时不产生耗时字段', () => {
  const list = [
    req('cdn.example.com', 'img', { cached: true, bytes: 100 }),
    req('cdn.example.com', 'img', { cached: true, bytes: 200 }),
  ]
  const [summary] = aggregate(list, 'example.com')
  assert.equal(summary.requests, 2)
  assert.equal(summary.p50TtfbMs, undefined)
  assert.equal(summary.p95TtfbMs, undefined)
  assert.equal(summary.p95TotalMs, undefined)
  assert.equal(summary.bytes, 300)
})

test('p95 采用最近秩法，p50 采用中位数', () => {
  const list = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) =>
    req('slow.example.com', 'xhr', { ttfbMs: ms, totalMs: ms }),
  )
  const [summary] = aggregate(list, 'example.com')
  assert.equal(summary.p95TtfbMs, 1000)
  assert.equal(summary.p50TtfbMs, 550)

  assert.equal(percentile([], 0.95), undefined)
  assert.equal(percentile([7], 0.95), 7) // 不足 1 条时返回该值
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([5]), 5)
})

test('>5s 判为慢，恰好 5000ms 不算慢', () => {
  assert.equal(isSlow(req('x.com', 'script', { ttfbMs: 5000, totalMs: 5000 })), false)
  assert.equal(isSlow(req('x.com', 'script', { ttfbMs: 5001 })), true)
  assert.equal(isSlow(req('x.com', 'script', { totalMs: 8000 })), true)
  assert.equal(isSlow(req('x.com', 'script', {})), false)
  // 阈值可覆盖
  assert.equal(isSlow(req('x.com', 'script', { ttfbMs: 3000 }), 2000), true)
})

test('超时判定覆盖契约里的错误码', () => {
  const t = (errorText: string, failed = true) => isTimeout(req('x.com', 'script', { failed, errorText }))
  assert.equal(t('net::ERR_TIMED_OUT'), true)
  assert.equal(t('net::ERR_CONNECTION_RESET'), true)
  assert.equal(t('net::ERR_CONNECTION_REFUSED'), true)
  assert.equal(t('net::ERR_CONNECTION_ABORTED'), true)
  assert.equal(t('net::ERR_NAME_NOT_RESOLVED'), true)
  assert.equal(t('net::ERR_EMPTY_RESPONSE'), true)
  assert.equal(t('net::ERR_CERT_DATE_INVALID'), false)
  assert.equal(t('net::ERR_TIMED_OUT', false), false)
  assert.equal(isTimeout(req('x.com', 'script', { failed: true })), false)
})

test('缓存谓词只认 cached === true', () => {
  assert.equal(isCached(req('x.com', 'img', { cached: true })), true)
  assert.equal(isCached(req('x.com', 'img', { cached: false })), false)
  assert.equal(isCached(req('x.com', 'img', {})), false)
})

test('主机名归一化：大小写、端口、尾部点、IPv6', () => {
  assert.equal(normalizeHost('  Ads.Example.COM:8443 '), 'ads.example.com')
  assert.equal(normalizeHost('example.com..'), 'example.com')
  assert.equal(normalizeHost('::1'), '::1')
  assert.equal(normalizeHost('[::1]:8080'), '[::1]')
  assert.equal(normalizeHost(''), '')
})

test('多级公共后缀能取到正确注册域', () => {
  assert.equal(registrableDomain('news.example.co.uk'), 'example.co.uk')
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk')
  assert.equal(registrableDomain('shop.example.com.cn'), 'example.com.cn')
  assert.equal(registrableDomain('www.example.com.au'), 'example.com.au')
  assert.equal(registrableDomain('player.co.jp'), 'player.co.jp')
  assert.equal(registrableDomain('user.github.io'), 'user.github.io')
  assert.equal(registrableDomain('example.com'), 'example.com')
  assert.equal(registrableDomain('www.example.com'), 'example.com')
  assert.equal(registrableDomain('localhost'), 'localhost')
  assert.equal(registrableDomain('203.0.113.7'), '203.0.113.7')
  assert.equal(isIpHost('203.0.113.7'), true)
  assert.equal(isIpHost('::1'), true)
  assert.equal(isIpHost('example.com'), false)
  assert.equal(thirdParty('203.0.113.7', 'example.com'), true)
})

test('第一方/第三方判定：同注册域为第一方', () => {
  assert.equal(thirdParty('static.example.co.uk', 'news.example.co.uk'), false)
  assert.equal(thirdParty('example.co.uk', 'www.example.co.uk'), false)
  assert.equal(thirdParty('cdn.ads-network.co.uk', 'news.example.co.uk'), true)
  assert.equal(thirdParty('user-a.github.io', 'user-b.github.io'), true)
  assert.equal(thirdParty('a.github.io', 'a.github.io'), false)
  // pageHost 缺失时保守判为第一方，避免误给屏蔽建议
  assert.equal(thirdParty('ads.doubleclick.net', ''), false)
})

test('kinds 去重且按固定顺序输出', () => {
  const list = [
    req('k.example.com', 'img'),
    req('k.example.com', 'document'),
    req('k.example.com', 'img'),
    req('k.example.com', 'font'),
  ]
  const [summary] = aggregate(list, 'example.com')
  assert.deepEqual(summary.kinds, ['document', 'img', 'font'])
})

test('排序：最慢的域名在前，其次请求数多者优先', () => {
  const list = [
    req('fast.example.com', 'script', { ttfbMs: 100 }),
    req('slow.example.com', 'script', { ttfbMs: 9000 }),
    req('mid.example.com', 'script', { ttfbMs: 2000 }),
    req('mid.example.com', 'img', { ttfbMs: 2100 }),
  ]
  const hosts = aggregate(list, 'example.com').map((s) => s.host)
  assert.deepEqual(hosts, ['slow.example.com', 'mid.example.com', 'fast.example.com'])
})

test('pageHost 缺省时从 document 请求推断第三方', () => {
  const list = [
    req('www.shop.com', 'document', { ttfbMs: 100 }),
    req('cdn.shop.com', 'script', { ttfbMs: 120 }),
    req('ads.tracker.net', 'script', { ttfbMs: 130 }),
  ]
  assert.equal(inferPageHost(list), 'www.shop.com')
  const summaries = aggregate(list)
  assert.equal(summaries.find((s) => s.host === 'cdn.shop.com')?.thirdParty, false)
  assert.equal(summaries.find((s) => s.host === 'ads.tracker.net')?.thirdParty, true)
})

test('host 为空的请求被丢弃，不影响其他域名统计', () => {
  const list = [
    req('', 'other', { ttfbMs: 10 }),
    req('ok.example.com', 'script', { ttfbMs: 20 }),
  ]
  const summaries = aggregate(list, 'example.com')
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].host, 'ok.example.com')
})

test('聚合结果默认 verdict 为 unknown，等待 advice 填充', () => {
  const [summary] = aggregate([req('a.example.com', 'script', { ttfbMs: 100 })], 'example.com')
  assert.equal(summary.verdict, 'unknown')
  assert.equal(summary.reason, '')
  assert.equal(summary.suggested, false)
})