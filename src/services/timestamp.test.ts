/**
 * hosts 头部时间戳的取值规则单测。
 *
 * 背景：手动加入自定义域名后，文件内容变了但头部时间没变，用户会以为没生效。
 * 原因是最初只取 domain_data.lastUpdated，而那个字段只在全量刷新时更新。
 *
 * 但也不能简单地把它改成当前时间——该字段同时是「缓存是否有效」的判据，
 * 一改就会让本该回源的旧数据被当成新鲜的。所以取两个时间的较新者。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLatest } from './timestamp.ts'

test('只有一个时间时直接返回', () => {
  assert.equal(pickLatest('2026-11-22T01:00:00.000Z'), '2026-11-22T01:00:00.000Z')
})

test('取较新的那个（自定义域名刚变更）', () => {
  const refresh = '2026-11-22T01:00:00.000Z'
  const touched = '2026-11-22T06:00:00.000Z'
  assert.equal(pickLatest(refresh, touched), touched)
})

test('取较新的那个（刚刷新过，自定义时间更早）', () => {
  const refresh = '2026-11-22T09:00:00.000Z'
  const touched = '2026-11-22T06:00:00.000Z'
  assert.equal(pickLatest(refresh, touched), refresh)
})

test('忽略 null / undefined / 空串 / 非法时间', () => {
  assert.equal(pickLatest(null, undefined, '', 'not-a-date'), null)
  assert.equal(pickLatest(null, '2026-11-22T02:00:00.000Z'), '2026-11-22T02:00:00.000Z')
  assert.equal(pickLatest('', 'bad', '2026-11-22T03:00:00.000Z'), '2026-11-22T03:00:00.000Z')
})

test('全部为空时返回 null（页面显示"未知"而不是错误时间）', () => {
  assert.equal(pickLatest(), null)
  assert.equal(pickLatest(null, null), null)
})

test('时间完全相同时返回前者，结果稳定', () => {
  const t = '2026-11-22T05:00:00.000Z'
  assert.equal(pickLatest(t, t), t)
})
