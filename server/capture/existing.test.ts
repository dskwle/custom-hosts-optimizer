import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markExisting, type ExistingSets } from './existing.ts'
import type { HostSummary } from './types.ts'

function row(host: string, suggested = true): HostSummary {
  return {
    host,
    requests: 4,
    failures: 1,
    bytes: 100,
    thirdParty: true,
    kinds: ['script'],
    verdict: 'block',
    reason: '第三方域名有失败',
    suggested,
  }
}

const sets = (over: Partial<ExistingSets> = {}): ExistingSets => ({
  builtin: new Set(),
  customAccel: new Set(),
  blocked: new Set(),
  ...over,
})

test('内置加速域名：打标且不再默认勾选', () => {
  const rows = [row('cdn.jsdelivr.net')]
  markExisting(rows, sets({ builtin: new Set(['cdn.jsdelivr.net']) }))
  assert.equal(rows[0].existing, 'builtin')
  assert.equal(rows[0].suggested, false)
})

test('自定义域名 / 屏蔽网站分别打标', () => {
  const rows = [row('my.example.com'), row('ads.example.com')]
  markExisting(rows, sets({
    customAccel: new Set(['my.example.com']),
    blocked: new Set(['ads.example.com']),
  }))
  assert.equal(rows[0].existing, 'custom-accel')
  assert.equal(rows[1].existing, 'blocked')
  assert.ok(rows.every((r) => !r.suggested))
})

test('优先级与 /apply 一致：内置 > 自定义 > 屏蔽', () => {
  const rows = [row('both.example.com')]
  markExisting(rows, sets({
    builtin: new Set(['both.example.com']),
    customAccel: new Set(['both.example.com']),
    blocked: new Set(['both.example.com']),
  }))
  assert.equal(rows[0].existing, 'builtin')
})

test('大小写不敏感', () => {
  const rows = [row('CDN.JSDELIVR.NET')]
  markExisting(rows, sets({ builtin: new Set(['cdn.jsdelivr.net']) }))
  assert.equal(rows[0].existing, 'builtin')
})

test('未命中规则的域名保持原样，suggested 不被改掉', () => {
  const rows = [row('new.example.com'), row('ignored.example.com', false)]
  markExisting(rows, sets())
  assert.equal(rows[0].existing, undefined)
  assert.equal(rows[0].suggested, true)
  assert.equal(rows[1].suggested, false)
})

test('只关默认勾选，不强制禁止（用户手动勾的选项不受影响）', () => {
  const rows = [row('ads.example.com')]
  markExisting(rows, sets({ blocked: new Set(['ads.example.com']) }))
  // 前端仍可把它加进 cap.selected，这里只是不再自动预选
  assert.equal(rows[0].verdict, 'block')
  assert.equal(rows[0].suggested, false)
})
