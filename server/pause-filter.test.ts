/**
 * 「只看已暂停」筛选是附加过滤，不是分类：
 * 它应该和另外四个分类是「与」关系，勾上后只保留被暂停的内置条目。
 * 这段逻辑在 /local/lookup 里内联，抽出来便于验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPaused } from './pause-filter.ts'

const rows = [
  { domain: 'a.com', paused: true },
  { domain: 'b.com', paused: false },
  { domain: 'c.com', paused: true },
  { domain: 'd.com' }, // 无 paused 字段，视为未暂停
]

test('未勾选时原样返回', () => {
  assert.deepEqual(pickPaused(rows, false).map((r) => r.domain), ['a.com', 'b.com', 'c.com', 'd.com'])
})

test('勾选后只保留已暂停', () => {
  assert.deepEqual(pickPaused(rows, true).map((r) => r.domain), ['a.com', 'c.com'])
})

test('paused 字段缺失视为未暂停', () => {
  const only = pickPaused([{ domain: 'x.com' }], true)
  assert.equal(only.length, 0)
})

test('空输入不报错', () => {
  assert.deepEqual(pickPaused([], true), [])
})
