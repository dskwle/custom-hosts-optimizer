// cdp.ts 纯函数与 RequestTracker 的单测（B lane）。
//
// 之所以单独开一个文件而不是并进 aggregate.test.ts：契约 §7 里 aggregate/advice
// 的测试归 C 所有，这份只覆盖 cdp.ts 的事件映射与耗时口径，两边互不影响。
//
// 用 node --experimental-strip-types 直接跑（见 scripts/check.sh），不依赖打包。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RequestTracker,
  elapsedMs,
  hostFromUrl,
  isCachedResponse,
  kindFromResourceType,
  roundMs,
  ttfbFromTiming,
} from './cdp.ts'
import type { CapturedRequest } from './types.ts'

// ---------------------------------------------------------------- kindFromResourceType

test('ResourceType 映射到契约的 7 种 kind', () => {
  assert.equal(kindFromResourceType('Document'), 'document')
  assert.equal(kindFromResourceType('Script'), 'script')
  assert.equal(kindFromResourceType('XHR'), 'xhr')
  assert.equal(kindFromResourceType('Fetch'), 'xhr')
  assert.equal(kindFromResourceType('Image'), 'img')
  assert.equal(kindFromResourceType('Font'), 'font')
  assert.equal(kindFromResourceType('Media'), 'media')
  assert.equal(kindFromResourceType('TextTrack'), 'media')
  // 契约没有对应类型的一律归 other，避免前端筛选器出现空组
  for (const t of ['Stylesheet', 'Manifest', 'WebSocket', 'Prefetch', 'Ping', 'Other', undefined, '']) {
    assert.equal(kindFromResourceType(t), 'other')
  }
})

// ---------------------------------------------------------------- hostFromUrl

test('host 取小写、去端口，且不接受无 host 的 URL', () => {
  assert.equal(hostFromUrl('https://WWW.Example.COM:8443/a.js'), 'www.example.com')
  assert.equal(hostFromUrl('https://example.com/x'), 'example.com')
  assert.equal(hostFromUrl('http://[::1]:8080/x'), '[::1]')
  // data:/blob:/chrome-extension: 没有可改 hosts 的域名，必须丢弃
  assert.equal(hostFromUrl('data:text/plain,hi'), '')
  assert.equal(hostFromUrl('blob:https://example.com/uuid'), '')
  assert.equal(hostFromUrl(''), '')
  assert.equal(hostFromUrl('不是 URL'), '')
})

// ---------------------------------------------------------------- 耗时口径

test('TTFB 取 receiveHeadersEnd 减 sendStart，含握手等待', () => {
  const timing = {
    requestTime: 1000,
    dnsStart: 0,
    dnsEnd: 12.4,
    connectStart: 12.4,
    connectEnd: 60.8,
    sendStart: 61.2,
    sendEnd: 61.5,
    receiveHeadersEnd: 861.7,
  }
  // 861.7 - 61.2 = 800.5 → 801（四舍五入）
  assert.equal(ttfbFromTiming(timing), 801)
})

test('sendStart 为 -1（复用连接）时退化为 receiveHeadersEnd', () => {
  assert.equal(ttfbFromTiming({ sendStart: -1, receiveHeadersEnd: 240.2 }), 240)
})

test('timing 缺失或非法时不给值', () => {
  assert.equal(ttfbFromTiming(undefined), undefined)
  assert.equal(ttfbFromTiming({}), undefined)
  assert.equal(ttfbFromTiming({ receiveHeadersEnd: -1 }), undefined)
  // 负数（脏数据）不能当成"很快"
  assert.equal(ttfbFromTiming({ sendStart: 900, receiveHeadersEnd: 100 }), undefined)
})

test('roundMs 过滤负值与离谱值', () => {
  assert.equal(roundMs(0), 0)
  assert.equal(roundMs(12.6), 13)
  assert.equal(roundMs(-5), undefined)
  assert.equal(roundMs(Number.NaN), undefined)
  assert.equal(roundMs(600_001), undefined)
})

test('elapsedMs 按 CDP 的秒级单调时间戳算毫秒', () => {
  assert.equal(elapsedMs(1000, 1000.25), 250)
  assert.equal(elapsedMs(1000.001, 1000.0023), 1)
  assert.equal(elapsedMs(Number.NaN, 1), undefined)
})

test('缓存判定只看 fromDiskCache / fromMemoryCache', () => {
  assert.equal(isCachedResponse({ fromDiskCache: true }), true)
  assert.equal(isCachedResponse({ fromMemoryCache: true }), true)
  // Service Worker 可能是现场生成的响应，标成缓存会把真实慢请求藏起来
  assert.equal(isCachedResponse({ fromServiceWorker: true }), false)
  assert.equal(isCachedResponse({ status: 200 }), false)
  assert.equal(isCachedResponse(undefined), false)
})

// ---------------------------------------------------------------- RequestTracker

interface Harness {
  tracker: RequestTracker
  events: CapturedRequest[]
}

function harness(storeUrls = false): Harness {
  const events: CapturedRequest[] = []
  const tracker = new RequestTracker({ storeUrls, onRequest: (r) => events.push(r) })
  return { tracker, events }
}

const T0 = 1000

function willBeSent(over: Record<string, unknown> = {}) {
  return {
    requestId: 'r1',
    timestamp: T0,
    type: 'Script',
    frameId: 'F1',
    request: { url: 'https://cdn.example.net/app.js', method: 'GET' },
    ...over,
  }
}

test('完整生命周期：requestWillBeSent → responseReceived → loadingFinished', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent())
  tracker.handle('Network.responseReceived', {
    requestId: 'r1',
    timestamp: T0 + 0.3,
    response: {
      status: 200,
      timing: { sendStart: 10, receiveHeadersEnd: 310 },
      fromDiskCache: false,
    },
  })
  tracker.handle('Network.loadingFinished', {
    requestId: 'r1',
    timestamp: T0 + 0.42,
    encodedDataLength: 88_000,
  })

  assert.equal(events.length, 1)
  const req = events[0]
  assert.equal(req.requestId, 'r1')
  assert.equal(req.host, 'cdn.example.net')
  assert.equal(req.kind, 'script')
  assert.equal(req.status, 200)
  assert.equal(req.ttfbMs, 300)
  assert.equal(req.totalMs, 420)
  assert.equal(req.bytes, 88_000)
  assert.equal(req.frameId, 'F1')
  assert.equal(req.failed, undefined)
  // 隐私默认：不存 URL
  assert.equal(req.url, undefined)
})

test('storeUrls=true 时才带上完整 URL', () => {
  const { tracker, events } = harness(true)
  tracker.handle('Network.requestWillBeSent', willBeSent())
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.1 })
  assert.equal(events[0].url, 'https://cdn.example.net/app.js')
})

test('缓存命中标记 cached，且不给 ttfb/total', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent({ type: 'Image' }))
  tracker.handle('Network.requestServedFromCache', { requestId: 'r1' })
  tracker.handle('Network.responseReceived', {
    requestId: 'r1',
    timestamp: T0 + 0.001,
    response: { status: 200, fromDiskCache: true, timing: { sendStart: 0, receiveHeadersEnd: 0 } },
  })
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.002, encodedDataLength: 12 })

  const req = events[0]
  assert.equal(req.cached, true)
  // 缓存命中的 timing 全是 0，留下来会把 p95 拉低
  assert.equal(req.ttfbMs, undefined)
  assert.equal(req.totalMs, undefined)
  assert.equal(req.bytes, 12)
})

test('已缓存的请求后续再收到耗时事件也不会补上 ttfb', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent({ type: 'Image' }))
  tracker.handle('Network.responseReceived', {
    requestId: 'r1',
    timestamp: T0 + 0.1,
    response: { status: 200, fromMemoryCache: true },
  })
  assert.equal(events.length, 0) // 还没结束，不推送
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.2 })
  assert.equal(events[0].cached, true)
  assert.equal(events[0].ttfbMs, undefined)
})

test('loadingFailed 带 errorText；canceled 不算失败', () => {
  const a = harness()
  a.tracker.handle('Network.requestWillBeSent', willBeSent({ type: 'XHR' }))
  a.tracker.handle('Network.loadingFailed', {
    requestId: 'r1',
    timestamp: T0 + 8.5,
    errorText: 'net::ERR_TIMED_OUT',
  })
  assert.equal(a.events[0].failed, true)
  assert.equal(a.events[0].errorText, 'net::ERR_TIMED_OUT')
  assert.equal(a.events[0].totalMs, 8500)

  // 导航打断产生的 canceled 不是网络问题，标成失败会误导用户去屏蔽
  const b = harness()
  b.tracker.handle('Network.requestWillBeSent', willBeSent())
  b.tracker.handle('Network.loadingFailed', {
    requestId: 'r1',
    timestamp: T0 + 0.05,
    errorText: 'net::ERR_ABORTED',
    canceled: true,
  })
  assert.equal(b.events[0].failed, undefined)
  assert.equal(b.events[0].errorText, undefined)
})

test('重定向：上一条按 3xx 结账，新一条用新 URL 起算', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', {
    requestId: 'r1',
    timestamp: T0,
    type: 'Document',
    request: { url: 'http://example.com/' },
  })
  tracker.handle('Network.requestWillBeSent', {
    requestId: 'r1',
    timestamp: T0 + 0.2,
    type: 'Document',
    request: { url: 'https://www.example.com/' },
    redirectResponse: { status: 301 },
  })

  // 重定向事件当场把第一跳结账（301）
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 301)
  assert.equal(events[0].host, 'example.com')

  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.6 })

  // 第二跳由 loadingFinished 结账，耗时从它自己的 timestamp 起算
  assert.equal(events.length, 2)
  assert.equal(events[1].host, 'www.example.com')
  assert.equal(events[1].totalMs, 400)

  // 都结完了，flush 不应再产出重复条目
  tracker.flush()
  assert.equal(events.length, 2)
})

test('无 host 的请求（data:/blob:）直接丢弃', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent({ request: { url: 'data:text/css,a{}' } }))
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.1 })
  assert.equal(events.length, 0)
})

test('flush 把在途请求按已测得数据结账', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent())
  tracker.handle('Network.responseReceived', {
    requestId: 'r1',
    timestamp: T0 + 0.1,
    response: { status: 204 },
  })
  tracker.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 204)
  assert.equal(events[0].totalMs, undefined) // 没结束，总耗时未知
})

test('sweep 只结账超时未完成的请求（按墙钟时间）', () => {
  const events: CapturedRequest[] = []
  const tracker = new RequestTracker({ stuckMs: 1000, onRequest: (r) => events.push(r) })
  const received = Date.now()
  tracker.handle('Network.requestWillBeSent', willBeSent({ timestamp: T0 }))
  tracker.sweep(received + 500) // 才 500ms
  assert.equal(events.length, 0)
  tracker.sweep(received + 1500)
  assert.equal(events.length, 1)
})

test('beginEpoch 让重连后的同名 requestId 不会被当成重复', () => {
  const { tracker, events } = harness()
  tracker.handle('Network.requestWillBeSent', willBeSent())
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.1 })
  tracker.beginEpoch()
  // 重连后 CDP 从 1 重新编号
  tracker.handle('Network.requestWillBeSent', willBeSent({ timestamp: T0 + 10 }))
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 10.1 })
  assert.equal(events.length, 2)
  assert.equal(events[1].totalMs, 100)
})

test('未知事件与脏数据不影响后续采集', () => {
  const { tracker, events } = harness()
  tracker.handle('Page.loadEventFired', {})
  tracker.handle('Network.requestWillBeSent', { requestId: 'r1' } as never) // 没有 timestamp/request
  tracker.handle('Network.requestWillBeSent', willBeSent())
  tracker.handle('Network.loadingFinished', { requestId: 'r1', timestamp: T0 + 0.1 })
  assert.equal(events.length, 1)
})
