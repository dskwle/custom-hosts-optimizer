import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRetry, shouldBlocklist } from './retry-plan.ts'

const now = Date.parse('2026-11-22T02:00:00.000Z')
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

test('距上次失败不足间隔的不重试', () => {
  const r = planRetry({
    failures: [{ domain: 'a.com', consecutive: 3, lastFailedAt: iso(30_000) }],
    blocked: [],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, [])
  assert.equal(r.waiting, 1)
})

test('到期的域名进入本轮', () => {
  const r = planRetry({
    failures: [{ domain: 'a.com', consecutive: 3, lastFailedAt: iso(70_000) }],
    blocked: [],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, ['a.com'])
})

test('已在排除清单的域名不再重试', () => {
  const r = planRetry({
    failures: [{ domain: 'a.com', consecutive: 60, lastFailedAt: iso(90_000) }],
    blocked: ['a.com'],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, [])
})

test('按最早失败优先，避免后面的域名被饿死', () => {
  const r = planRetry({
    failures: [
      { domain: 'new.com', consecutive: 1, lastFailedAt: iso(61_000) },
      { domain: 'old.com', consecutive: 5, lastFailedAt: iso(600_000) },
      { domain: 'mid.com', consecutive: 2, lastFailedAt: iso(120_000) },
    ],
    blocked: [],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, ['old.com', 'mid.com', 'new.com'])
})

test('limit 截断，本轮只测前 N 个', () => {
  const failures = Array.from({ length: 30 }, (_, i) => ({
    domain: `d${i}.com`,
    consecutive: 1,
    lastFailedAt: iso(120_000 + i * 1000),
  }))
  const r = planRetry({ failures, blocked: [], limit: 20, now })
  assert.equal(r.due.length, 20)
})

test('时间戳异常时当作早已到期（宁可多测不卡住）', () => {
  const r = planRetry({
    failures: [{ domain: 'x.com', consecutive: 1, lastFailedAt: 'not-a-date' }],
    blocked: [],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, ['x.com'])
})

test('大小写不敏感地跳过已阻断域名', () => {
  const r = planRetry({
    failures: [{ domain: 'A.com', consecutive: 60, lastFailedAt: iso(90_000) }],
    blocked: ['a.com'],
    limit: 10,
    now,
  })
  assert.deepEqual(r.due, [])
})

test('shouldBlocklist：三个条件同时满足才判死', () => {
  assert.equal(shouldBlocklist({ ok: false, verdict: 'sni-blocked', consecutive: 60, threshold: 60 }), true)
  // 成功不判死
  assert.equal(shouldBlocklist({ ok: true, verdict: 'sni-blocked', consecutive: 60, threshold: 60 }), false)
  // 次数不够
  assert.equal(shouldBlocklist({ ok: false, verdict: 'sni-blocked', consecutive: 59, threshold: 60 }), false)
  // 超时（unknown）即使次数再多也不判死
  assert.equal(shouldBlocklist({ ok: false, verdict: 'unknown', consecutive: 999, threshold: 60 }), false)
  // tcp-blocked 同样不判死
  assert.equal(shouldBlocklist({ ok: false, verdict: 'tcp-blocked', consecutive: 999, threshold: 60 }), false)
})

test('阈值可配置，默认语义不受影响', () => {
  assert.equal(shouldBlocklist({ ok: false, verdict: 'sni-blocked', consecutive: 5, threshold: 5 }), true)
  assert.equal(shouldBlocklist({ ok: false, verdict: 'sni-blocked', consecutive: 4, threshold: 5 }), false)
})
