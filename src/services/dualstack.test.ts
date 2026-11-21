/**
 * 双栈输出逻辑单测。
 *
 * 重点：v4 通、v6 全废时，只「不输出 v6」是不够的 —— 客户端会自己查 AAAA
 * 拿到坏地址、等超时才回落 v4。必须显式写 `::  域名`，且不能封掉 v4。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterByFamily, formatV6OnlySection, isIpv6Addr } from './dualstack.ts'

test('isIpv6Addr：含冒号即 v6', () => {
  assert.equal(isIpv6Addr('2001:db8::1'), true)
  assert.equal(isIpv6Addr('::'), true)
  assert.equal(isIpv6Addr('203.0.113.10'), false)
})

test('filterByFamily 非 v4 模式原样返回', () => {
  const rows: [string, string][] = [
    ['203.0.113.10', 'example.com'],
    ['2001:db8::1', 'example.com'],
  ]
  assert.equal(filterByFamily(rows, false).length, 2)
})

test('filterByFamily v4 模式剔除 v6、保留 v4', () => {
  const rows: [string, string][] = [
    ['203.0.113.10', 'example.com'],
    ['2001:db8::1', 'example.com'],
    ['203.0.113.20', 'v4only.example.com'],
  ]
  const out = filterByFamily(rows, true)
  assert.deepEqual(out, [
    ['203.0.113.10', 'example.com'],
    ['203.0.113.20', 'v4only.example.com'],
  ])
})

test('v6-only 段用 :: 而不是 0.0.0.0（否则 v4 也被封）', () => {
  const s = formatV6OnlySection(['half.example.com'])
  assert.match(s, /^::\s+half\.example\.com$/m)
  assert.doesNotMatch(s, /0\.0\.0\.0\s+half\.example\.com/)
  assert.match(s, /仅屏蔽 IPv6/)
})

test('已在完整屏蔽清单里的域名不重复写', () => {
  const s = formatV6OnlySection(['both.example.com'], { blocked: ['both.example.com'] })
  assert.equal(s, '')
})

test('大小写不敏感地去重', () => {
  const s = formatV6OnlySection(['Both.Example.COM'], { blocked: ['both.example.com'] })
  assert.equal(s, '')
})

test('空输入返回空串，不产生多余段落', () => {
  assert.equal(formatV6OnlySection([]), '')
})

test('多个域名每个一行，且域名数标注正确', () => {
  const s = formatV6OnlySection(['a.example.com', 'b.example.com'])
  assert.equal(s.split('\n').filter((l) => l.startsWith('::')).length, 2)
  assert.match(s, /域名数：2/)
})
