/**
 * 地址族补齐单测。
 *
 * 核心需求：只给 v4 就屏蔽 v6，只给 v6 就屏蔽 v4。
 * 这是为了防止双栈客户端从真实 DNS 拿到另一族的坏地址。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeAddrFamilies,
  isIpv4Addr,
  isIpv6Loose,
  isHostAddr,
  parseAddrInput,
  BLOCK_ADDR_V4,
  BLOCK_ADDR_V6,
} from './dualstack.ts'

test('只给 v4 → 补 :: 屏蔽 v6', () => {
  const r = completeAddrFamilies(['1.2.3.4'])
  assert.deepEqual(r.addrs, ['1.2.3.4', '::'])
  assert.deepEqual(r.synthesized, ['::'])
})

test('只给 v6 时 v4 被补成 0.0.0.0', () => {
  const r = completeAddrFamilies(['2001:db8::1'])
  assert.ok(r.addrs.includes(BLOCK_ADDR_V4), '必须补 v4 屏蔽地址')
  assert.ok(r.addrs.includes('2001:db8::1'))
  assert.equal(r.addrs.length, 2)
  assert.deepEqual(r.synthesized, [BLOCK_ADDR_V4])
})

test('v4 + v6 都给了 → 不补任何屏蔽地址', () => {
  const r = completeAddrFamilies(['1.2.3.4', '2001:db8::1'])
  assert.deepEqual(r.addrs, ['1.2.3.4', '2001:db8::1'])
  assert.deepEqual(r.synthesized, [])
})

test('多个 v4 全部保留，顺序稳定', () => {
  const r = completeAddrFamilies(['1.1.1.1', '2.2.2.2', '3.3.3.3'])
  assert.deepEqual(r.addrs, ['1.1.1.1', '2.2.2.2', '3.3.3.3', '::'])
})

test('多个 v6 全部保留', () => {
  const r = completeAddrFamilies(['2001:db8::1', '2001:db8::2'])
  assert.ok(r.addrs.includes('2001:db8::1'))
  assert.ok(r.addrs.includes('2001:db8::2'))
  assert.ok(r.addrs.includes(BLOCK_ADDR_V4))
})

test('v4 永远排在 v6 前面', () => {
  const r = completeAddrFamilies(['2001:db8::1', '1.1.1.1'])
  assert.equal(r.addrs[0], '1.1.1.1')
})

test('去重', () => {
  const r = completeAddrFamilies(['1.1.1.1', '1.1.1.1'])
  assert.deepEqual(r.addrs, ['1.1.1.1', '::'])
})

test('非法地址被丢弃', () => {
  const r = completeAddrFamilies(['not-an-ip', '999.1.1.1', '1.2.3.4'])
  assert.deepEqual(r.addrs, ['1.2.3.4', '::'])
})

test('全非法 → 两族都屏蔽（等于该域名不可用）', () => {
  const r = completeAddrFamilies(['garbage'])
  assert.deepEqual(r.addrs, [BLOCK_ADDR_V4, BLOCK_ADDR_V6])
  assert.equal(r.synthesized.length, 2)
})

test('空输入 → 两族都屏蔽', () => {
  const r = completeAddrFamilies([])
  assert.deepEqual(r.addrs, [BLOCK_ADDR_V4, BLOCK_ADDR_V6])
})

test('isIpv4Addr 边界', () => {
  assert.equal(isIpv4Addr('1.2.3.4'), true)
  assert.equal(isIpv4Addr('255.255.255.255'), true)
  assert.equal(isIpv4Addr('256.1.1.1'), false)
  assert.equal(isIpv4Addr('1.2.3'), false)
  assert.equal(isIpv4Addr('2001:db8::1'), false)
  assert.equal(isIpv4Addr(''), false)
})

test('isIpv6Loose 识别常见写法', () => {
  assert.equal(isIpv6Loose('2001:db8::1'), true)
  assert.equal(isIpv6Loose('::1'), true)
  assert.equal(isIpv6Loose('::'), true)
  assert.equal(isIpv6Loose('fe80::1%eth0'), false, '带 zone 的不接受')
  assert.equal(isIpv6Loose('1.2.3.4'), false)
})

test('isHostAddr 两者都认', () => {
  assert.equal(isHostAddr('1.2.3.4'), true)
  assert.equal(isHostAddr('2001:db8::1'), true)
  assert.equal(isHostAddr('nope'), false)
})

test('parseAddrInput 支持数组/逗号/空格/换行/分号', () => {
  assert.deepEqual(parseAddrInput(['1.1.1.1', '2.2.2.2']), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseAddrInput('1.1.1.1, 2.2.2.2'), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseAddrInput('1.1.1.1\n2.2.2.2'), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseAddrInput('1.1.1.1;2.2.2.2'), ['1.1.1.1', '2.2.2.2'])
})

test('parseAddrInput 处理 null / undefined / 嵌套数组', () => {
  assert.deepEqual(parseAddrInput(null), [])
  assert.deepEqual(parseAddrInput(undefined), [])
  assert.deepEqual(parseAddrInput(['1.1.1.1', ['2.2.2.2']]), ['1.1.1.1', '2.2.2.2'])
})
