/**
 * 候选判定单测。
 *
 * 重点关注实测中暴露的两类误判：
 *   1. CDN 多 IP 被当成污染（cdn.jsdelivr.net：源不一致，但 11/11 握手成功）
 *   2. 本来就能通的域名被建议加速（只会更慢）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeCandidate, MIN_GAIN_MS, type CandidateInput } from './discover-judge.ts'

const base = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  domain: 'example.com',
  systemIps: ['203.0.113.1'],
  systemBestMs: 300,
  bestIpMs: 250,
  inconsistent: false,
  systemDiffers: false,
  alreadyAccelerated: false,
  alreadyBlocked: false,
  sniBlocked: false,
  ...over,
})

test('系统解析全部不通 + 候选可用 → 建议加速', () => {
  const r = judgeCandidate(base({ systemBestMs: null }))
  assert.equal(r.verdict, 'recommend')
})

test('系统解析不通 + 疑似劫持 → 建议加速且说明原因', () => {
  const r = judgeCandidate(base({ systemBestMs: null, systemDiffers: true }))
  assert.equal(r.verdict, 'recommend')
  assert.match(r.reason, /劫持/)
})

test('收益超过阈值 → 建议加速，并给出 gainMs', () => {
  const r = judgeCandidate(base({ systemBestMs: 400, bestIpMs: 200 }))
  assert.equal(r.verdict, 'recommend')
  assert.equal(r.gainMs, 200)
})

test('收益不足阈值 → 建议不动（CDN 正常多节点场景）', () => {
  const r = judgeCandidate(base({ systemBestMs: 300, bestIpMs: 250 }))
  assert.equal(r.verdict, 'noop')
})

test('刚好等于阈值算建议（边界）', () => {
  const r = judgeCandidate(base({ systemBestMs: 300, bestIpMs: 300 - MIN_GAIN_MS }))
  assert.equal(r.verdict, 'recommend')
})

test('CDN 源不一致但系统可用且不慢 → noop，不能当污染处理', () => {
  // 复现 cdn.jsdelivr.net：inconsistent=true，但所有 IP 都好用
  const r = judgeCandidate(
    base({ inconsistent: true, systemDiffers: false, systemBestMs: 300, bestIpMs: 280 }),
  )
  assert.equal(r.verdict, 'noop')
  assert.match(r.reason, /CDN/)
})

test('没有可用候选 IP → unusable，绝不建议加速', () => {
  const r = judgeCandidate(base({ bestIpMs: null, systemBestMs: null }))
  assert.equal(r.verdict, 'unusable')
  assert.match(r.reason, /无法访问/)
})

test('SNI 阻断 → unusable（改 hosts 无效）', () => {
  const r = judgeCandidate(base({ sniBlocked: true, bestIpMs: null }))
  assert.equal(r.verdict, 'unusable')
  assert.match(r.reason, /代理/)
})

test('已在加速列表 → handled', () => {
  assert.equal(judgeCandidate(base({ alreadyAccelerated: true })).verdict, 'handled')
})

test('已在屏蔽清单 → handled，且优先于其它判断', () => {
  const r = judgeCandidate(base({ alreadyBlocked: true, sniBlocked: true, bestIpMs: null }))
  assert.equal(r.verdict, 'handled')
})

test('unusable 优先于 recommend：没有可用 IP 就不该建议', () => {
  // 即使系统完全不通，若候选也不可用，仍不能建议（否则写进去就打不开）
  const r = judgeCandidate(base({ systemBestMs: null, bestIpMs: null }))
  assert.equal(r.verdict, 'unusable')
})
