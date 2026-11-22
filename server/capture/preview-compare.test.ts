/**
 * 预览对比单测。
 *
 * 这个功能的唯一价值是「别拿假数字骗用户去改 hosts」，
 * 所以测试重点全在"什么情况下不能下结论"：
 * 样本不足、预览后没请求、映射后反而失败、差异在噪声范围内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePreview, MIN_SAMPLES, type HostTiming } from './preview-compare.ts'

const t = (host: string, p95: number, requests = 10, failures = 0): HostTiming => ({
  host,
  requests,
  p95TotalMs: p95,
  failures,
})

test('明显变快 → faster，给出 delta', () => {
  const rows = comparePreview([t('a.com', 400)], [t('a.com', 200)], ['a.com'])
  assert.equal(rows[0].verdict, 'faster')
  assert.equal(rows[0].deltaMs, -200)
  assert.equal(rows[0].deltaPct, -50)
  assert.match(rows[0].note, /变快 200ms/)
})

test('明显变慢 → slower，并提示该 IP 不如当前解析', () => {
  const rows = comparePreview([t('a.com', 200)], [t('a.com', 400)], ['a.com'])
  assert.equal(rows[0].verdict, 'slower')
  assert.match(rows[0].note, /不如当前解析/)
})

test('差异在噪声范围内 → same，明确说不值得改', () => {
  // 200 → 210 只有 5%
  const rows = comparePreview([t('a.com', 200)], [t('a.com', 210)], ['a.com'])
  assert.equal(rows[0].verdict, 'same')
  assert.match(rows[0].note, /噪声范围/)
})

test('样本不足 → insufficient，不判优劣', () => {
  const few = MIN_SAMPLES - 1
  const rows = comparePreview([t('a.com', 400, few)], [t('a.com', 100)], ['a.com'])
  assert.equal(rows[0].verdict, 'insufficient')
  assert.equal(rows[0].deltaMs, null)
  assert.match(rows[0].note, /样本不足/)
})

test('映射后出现失败（原来没失败）→ failed，明确警告不要写', () => {
  const rows = comparePreview([t('a.com', 300, 10, 0)], [t('a.com', 300, 10, 3)], ['a.com'])
  assert.equal(rows[0].verdict, 'failed')
  assert.match(rows[0].note, /不要写入/)
})

test('预览后没有该域名请求 → insufficient，不能当变快', () => {
  const rows = comparePreview([t('a.com', 300)], [], ['a.com'])
  assert.equal(rows[0].verdict, 'insufficient')
  assert.match(rows[0].note, /未观察到/)
})

test('预览前没有基线 → 不硬给结论', () => {
  const rows = comparePreview([], [t('a.com', 200)], ['a.com'])
  assert.equal(rows[0].verdict, 'insufficient')
  assert.match(rows[0].note, /无基线/)
})

test('只输出被映射的域名，未映射的不进来', () => {
  const rows = comparePreview(
    [t('a.com', 300), t('other.com', 500)],
    [t('a.com', 100), t('other.com', 100)],
    ['a.com'],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].host, 'a.com')
})

test('域名大小写不敏感', () => {
  const rows = comparePreview([t('A.COM', 400)], [t('a.com', 100)], ['A.com'])
  assert.equal(rows[0].verdict, 'faster')
})

test('faster 排在 slower / same 前面（最值得看的先出现）', () => {
  const rows = comparePreview(
    [t('slow.com', 200), t('fast.com', 400), t('same.com', 200)],
    [t('slow.com', 400), t('fast.com', 100), t('same.com', 205)],
    ['slow.com', 'fast.com', 'same.com'],
  )
  assert.equal(rows[0].host, 'fast.com')
  assert.equal(rows[1].host, 'slow.com')
})

test('缺 p95 数据 → insufficient 而不是崩', () => {
  const rows = comparePreview(
    [{ host: 'a.com', requests: 10, failures: 0 }],
    [{ host: 'a.com', requests: 10, failures: 0 }],
    ['a.com'],
  )
  assert.equal(rows[0].verdict, 'insufficient')
  assert.match(rows[0].note, /缺少耗时/)
})
