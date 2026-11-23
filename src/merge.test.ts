/**
 * 自定义域名优先级与分组归属的单测。
 *
 * 重点验证三件容易做错的事：
 *   1. 自定义 IP 必须赢过内置（这是需求的核心）
 *   2. 只换 IP 时不能把原本的分组归属弄丢
 *   3. 非法分组 id 不能让条目凭空消失
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeCustomWithBuiltin,
  resolveGroups,
  countByGroup,
  filterByGroup,
  type MergeInput,
} from './merge.ts'

const VALID = new Set(['github', 'npm', 'cdn', 'web'])

function mk(partial: Partial<MergeInput> = {}): MergeInput {
  return {
    builtin: new Map([
      ['api.github.com', '1.1.1.1'],
      ['registry.npmjs.org', '2.2.2.2'],
    ]),
    builtinGroups: new Map([
      ['api.github.com', ['github']],
      ['registry.npmjs.org', ['npm']],
    ]),
    custom: [],
    validGroupIds: VALID,
    ...partial,
  }
}

test('自定义 IP 覆盖内置同名条目', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'api.github.com', ip: '9.9.9.9' }] }),
  )
  const hit = rows.find((r) => r.domain === 'api.github.com')!
  assert.equal(hit.ip, '9.9.9.9', '自定义地址必须赢')
  assert.equal(hit.fromCustom, true)
  assert.equal(hit.overrode, true)
})

test('只换 IP、不指定分组时，沿用内置分组归属', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'api.github.com', ip: '9.9.9.9' }] }),
  )
  const hit = rows.find((r) => r.domain === 'api.github.com')!
  assert.deepEqual(hit.groups, ['github'], '不能因为改 IP 就丢掉分组')
})

test('显式指定分组时覆盖内置归属', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'api.github.com', ip: '9.9.9.9', groups: ['web'] }] }),
  )
  const hit = rows.find((r) => r.domain === 'api.github.com')!
  assert.deepEqual(hit.groups, ['web'])
})

test('多选分组', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'x.com', ip: '8.8.8.8', groups: ['github', 'npm'] }] }),
  )
  assert.deepEqual(rows.find((r) => r.domain === 'x.com')!.groups.sort(), ['github', 'npm'])
})

test('groups 含 all → 全部分组（沿用内置或空）', () => {
  // 新域名 + all → 没有内置归属，groups 为空数组
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'new.com', ip: '8.8.8.8', groups: ['all'] }] }),
  )
  assert.deepEqual(rows.find((r) => r.domain === 'new.com')!.groups, [])
})

test('纯自定义域名（不在任何内置分组）groups 为空但不丢失', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'mine.com', ip: '7.7.7.7' }] }),
  )
  const hit = rows.find((r) => r.domain === 'mine.com')!
  assert.ok(hit, '必须存在')
  assert.deepEqual(hit.groups, [])
  assert.equal(hit.overrode, false)
})

test('非法分组 id 被忽略，全非法时按全部分组兜底', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'z.com', ip: '6.6.6.6', groups: ['nope', 'bogus'] }] }),
  )
  assert.deepEqual(rows.find((r) => r.domain === 'z.com')!.groups, [],
    '全非法时不能变成某个奇怪分组，应退化为纯自定义')
})

test('部分非法时只保留合法的', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'z.com', ip: '6.6.6.6', groups: ['web', 'bogus'] }] }),
  )
  assert.deepEqual(rows.find((r) => r.domain === 'z.com')!.groups, ['web'])
})

test('域名大小写不敏感，不会产生重复条目', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'API.GitHub.COM', ip: '9.9.9.9' }] }),
  )
  const hits = rows.filter((r) => r.domain === 'api.github.com')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].ip, '9.9.9.9')
})

test('输出按域名排序，稳定可 diff', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'zzz.com', ip: '1.1.1.1' }, { domain: 'aaa.com', ip: '2.2.2.2' }] }),
  )
  const names = rows.map((r) => r.domain)
  assert.deepEqual(names, [...names].sort())
})

test('resolveGroups：空/未指定 → null（全部分组）', () => {
  assert.equal(resolveGroups(undefined, VALID), null)
  assert.equal(resolveGroups([], VALID), null)
  assert.equal(resolveGroups(null, VALID), null)
})

test('resolveGroups：含 all → null', () => {
  assert.equal(resolveGroups(['all'], VALID), null)
  assert.equal(resolveGroups(['github', 'all'], VALID), null)
})

test('countByGroup 统计各分组条目数', () => {
  const rows = mergeCustomWithBuiltin(
    mk({
      custom: [
        { domain: 'a.com', ip: '1.1.1.1', groups: ['github'] },
        { domain: 'b.com', ip: '2.2.2.2', groups: ['github', 'npm'] },
      ],
    }),
  )
  const c = countByGroup(rows)
  assert.equal(c.get('github'), 3) // api.github.com + a.com + b.com
  assert.equal(c.get('npm'), 2) // registry.npmjs.org + b.com
})

test('filterByGroup 只选包含该分组的条目', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'a.com', ip: '1.1.1.1', groups: ['github'] }] }),
  )
  const gh = filterByGroup(rows, 'github')
  assert.ok(gh.some((r) => r.domain === 'api.github.com'))
  assert.ok(gh.some((r) => r.domain === 'a.com'))
  assert.ok(!gh.some((r) => r.domain === 'registry.npmjs.org'))
})

test('filterByGroup 无分组条目默认不出现，除非显式要求', () => {
  const rows = mergeCustomWithBuiltin(mk({ custom: [{ domain: 'loose.com', ip: '5.5.5.5' }] }))
  assert.ok(!filterByGroup(rows, 'github').some((r) => r.domain === 'loose.com'))
  assert.ok(
    filterByGroup(rows, 'github', true).some((r) => r.domain === 'loose.com'),
    'includeUngrouped 时应出现',
  )
})

test('自定义多地址整组替换内置单地址', () => {
  const rows = mergeCustomWithBuiltin(
    mk({
      custom: [
        { domain: 'api.github.com', ips: ['1.1.1.1', '2.2.2.2', '::'] },
      ],
    }),
  )
  const hit = rows.find((r) => r.domain === 'api.github.com')!
  assert.deepEqual(hit.ips, ['1.1.1.1', '2.2.2.2', '::'])
  assert.equal(hit.ip, '1.1.1.1', '主地址是第一个')
})

test('自定义多地址时不会只剩最后一条（覆盖 set 的坑）', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'api.github.com', ips: ['1.2.3.4', '3.3.3.3'] }] }),
  )
  assert.equal(rows.filter((r) => r.domain === 'api.github.com').length, 1)
  assert.equal(rows.find((r) => r.domain === 'api.github.com')!.ips.length, 2)
})

test('兼容旧写法：只给 ip 单值', () => {
  const rows = mergeCustomWithBuiltin(
    mk({ custom: [{ domain: 'api.github.com', ip: '9.9.9.9' }] }),
  )
  const hit = rows.find((r) => r.domain === 'api.github.com')!
  assert.deepEqual(hit.ips, ['9.9.9.9'])
  assert.equal(hit.ip, '9.9.9.9')
})

test('内置条目 ips 为单元素数组', () => {
  const rows = mergeCustomWithBuiltin(mk())
  const hit = rows.find((r) => r.domain === 'registry.npmjs.org')!
  assert.deepEqual(hit.ips, ['2.2.2.2'])
  assert.deepEqual(hit.ips, [hit.ip])
})
