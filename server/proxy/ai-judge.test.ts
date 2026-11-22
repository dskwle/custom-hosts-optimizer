/**
 * AI 判定结果的解析与合并单测（纯函数部分，不联网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdicts } from './ai-judge.ts'

test('标准 JSON 数组', () => {
  const r = parseVerdicts('[{"domain":"a.com","category":"ad","confidence":0.9}]')
  assert.equal(r.length, 1)
  assert.equal(r[0].domain, 'a.com')
  assert.equal(r[0].category, 'ad')
})

test('剥掉 markdown 围栏（模型常见输出）', () => {
  const r = parseVerdicts('```json\n[{"domain":"a.com","category":"track","confidence":0.8}]\n```')
  assert.equal(r.length, 1)
  assert.equal(r[0].category, 'track')
})

test('前后有解释文字时截取数组', () => {
  const r = parseVerdicts('结果如下：[{"domain":"a.com","category":"normal","confidence":0.7}] 以上。')
  assert.equal(r.length, 1)
})

test('顶层被包成 items 也能解', () => {
  const r = parseVerdicts('{"items":[{"domain":"a.com","category":"sdk","confidence":0.6}]}')
  assert.equal(r.length, 1)
  assert.equal(r[0].category, 'sdk')
})

test('丢弃非法 category', () => {
  const r = parseVerdicts('[{"domain":"a.com","category":"unknown","confidence":0.9}]')
  assert.equal(r.length, 0)
})

test('缺 confidence 时给 0.5，不整条丢弃', () => {
  const r = parseVerdicts('[{"domain":"a.com","category":"ad"}]')
  assert.equal(r.length, 1)
  assert.equal(r[0].confidence, 0.5)
})

test('confidence 越界会被夹到 0~1', () => {
  const r = parseVerdicts('[{"domain":"a.com","category":"ad","confidence":1.8}]')
  assert.equal(r[0].confidence, 1)
})

test('域名统一小写', () => {
  const r = parseVerdicts('[{"domain":"ADS.Foo.COM","category":"ad","confidence":0.9}]')
  assert.equal(r[0].domain, 'ads.foo.com')
})

test('空输入 / 非法 JSON 返回空数组不抛错', () => {
  assert.deepEqual(parseVerdicts(''), [])
  assert.deepEqual(parseVerdicts('not json at all'), [])
  assert.deepEqual(parseVerdicts('[]'), [])
})
