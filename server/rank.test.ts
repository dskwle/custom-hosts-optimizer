import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankTimingDetails, type TimingDetail } from './rank.ts'

const d = (ip: string, avg: number | null, okRate: number, best?: number | null): TimingDetail => ({
  ip,
  avgTotalMs: avg,
  bestTotalMs: best === undefined ? avg : best,
  okRate,
})

test('成功率优先：33% 快 IP 排在 100% 慢 IP 之后（截图里的场景）', () => {
  const rows = [
    d('172.67.147.183', 1213, 33),
    d('2606:4700:3031::6813:1cdb', 1775, 100),
  ]
  assert.equal(rankTimingDetails(rows)[0].ip, '2606:4700:3031::6813:1cdb')
})

test('成功率相同时按平均耗时升序', () => {
  const rows = [d('slow', 900, 100), d('fast', 300, 100), d('mid', 600, 100)]
  assert.deepEqual(rankTimingDetails(rows).map((x) => x.ip), ['fast', 'mid', 'slow'])
})

test('成功率分档精细：80% 排在 66% 前，即使更慢', () => {
  const rows = [d('a', 200, 66), d('b', 800, 80)]
  assert.equal(rankTimingDetails(rows)[0].ip, 'b')
})

test('平均耗时测不出的排最后，不管成功率是多少', () => {
  const rows = [d('unknown', null, 100), d('slow-ok', 2000, 33)]
  assert.equal(rankTimingDetails(rows)[0].ip, 'slow-ok')
})

test('成功率与平均耗时都相同时，按最快一次耗时排', () => {
  const rows = [d('a', 500, 100, 490), d('b', 500, 100, 420)]
  assert.equal(rankTimingDetails(rows)[0].ip, 'b')
})

test('不修改原数组（返回新数组）', () => {
  const rows = [d('a', 900, 33), d('b', 1200, 100)]
  const ranked = rankTimingDetails(rows)
  assert.equal(rows[0].ip, 'a')
  assert.equal(ranked[0].ip, 'b')
})
