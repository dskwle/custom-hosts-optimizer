/**
 * 代理聚合单测。
 *
 * 重点验证两件容易出错的事：
 *   1. 同一连接在多次轮询里重复出现，不能重复计数
 *   2. 字节数取的是连接的累计值，同一连接后续快照数值会变大，不能累加
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProxyAggregator, shouldTrackHost, normalizeProxyHost, type RawConnection } from './aggregate.ts'

const conn = (id: string, host: string, up = 100, down = 200, extra: Partial<RawConnection> = {}): RawConnection => ({
  id,
  metadata: { host, type: 'HTTPS', destinationPort: '443', sourceIP: '192.168.6.28' },
  upload: up,
  download: down,
  start: '2026-11-22T10:00:00Z',
  chains: ['DIRECT'],
  rule: 'RuleSet',
  ...extra,
})

test('同一连接重复出现在多次轮询里，只计一次', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'ads.foo.com')])
  a.ingest([conn('c1', 'ads.foo.com')])
  a.ingest([conn('c1', 'ads.foo.com')])
  const list = a.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].connections, 1)
})

test('字节数不因重复快照而累加（mihomo 给的是累计值）', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'ads.foo.com', 100, 200)])
  // 同一连接后续快照数值变大，是累计值不是增量
  a.ingest([conn('c1', 'ads.foo.com', 300, 900)])
  const s = a.list()[0]
  assert.equal(s.upload, 100)
  assert.equal(s.download, 200)
})

test('不同连接才累加字节', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'ads.foo.com', 100, 200)])
  a.ingest([conn('c2', 'ads.foo.com', 50, 80)])
  const s = a.list()[0]
  assert.equal(s.connections, 2)
  assert.equal(s.upload, 150)
  assert.equal(s.download, 280)
})

test('同一域名多连接时聚合到一行', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'a.com'), conn('c2', 'a.com'), conn('c3', 'b.com')])
  const list = a.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].host, 'a.com')
  assert.equal(list[0].connections, 2)
})

test('按连接数降序排列', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'low.com'), conn('c2', 'high.com'), conn('c3', 'high.com')])
  assert.equal(a.list()[0].host, 'high.com')
})

test('纯 IP / 内网 / localhost 不统计', () => {
  const a = new ProxyAggregator()
  a.ingest([
    conn('c1', '1.2.3.4'),
    conn('c2', 'localhost'),
    conn('c3', '192.168.1.1'),
    conn('c4', '10.0.0.5'),
    conn('c5', 'router.local'),
    conn('c6', 'real.com'),
  ])
  const hosts = a.list().map((x) => x.host)
  assert.deepEqual(hosts, ['real.com'])
})

test('没有 host 但有 sniffHost 时用 sniffHost', () => {
  const a = new ProxyAggregator()
  a.ingest([{ id: 'c1', metadata: { sniffHost: 'sniffed.com' } }])
  assert.equal(a.list()[0].host, 'sniffed.com')
})

test('chain / rule / type / 来源 IP 去重累积', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'a.com', 0, 0, { chains: ['DIRECT'], rule: 'RuleSet' })])
  a.ingest([conn('c2', 'a.com', 0, 0, { chains: ['PROXY', 'DIRECT'], rule: 'Match' })])
  const s = a.list()[0]
  assert.deepEqual(s.chains.sort(), ['DIRECT', 'PROXY'])
  assert.deepEqual(s.rules.sort(), ['Match', 'RuleSet'])
})

test('超过 maxHosts 后不再收新域名', () => {
  const a = new ProxyAggregator(2)
  a.ingest([conn('c1', 'a.com'), conn('c2', 'b.com'), conn('c3', 'c.com')])
  assert.equal(a.size, 2)
})

test('clear 重置全部状态', () => {
  const a = new ProxyAggregator()
  a.ingest([conn('c1', 'a.com')])
  a.clear()
  assert.equal(a.size, 0)
  assert.equal(a.totalConnections, 0)
  // 清空后同一 id 可以重新计入
  a.ingest([conn('c1', 'a.com')])
  assert.equal(a.list()[0].connections, 1)
})

test('host 归一化：去端口、小写、去尾点', () => {
  assert.equal(normalizeProxyHost('ADS.Foo.COM:443'), 'ads.foo.com')
  assert.equal(normalizeProxyHost('foo.com.'), 'foo.com')
  assert.equal(normalizeProxyHost('  Foo.COM  '), 'foo.com')
})

test('shouldTrackHost 边界', () => {
  assert.equal(shouldTrackHost('a.com'), true)
  assert.equal(shouldTrackHost(''), false)
  assert.equal(shouldTrackHost(null), false)
  assert.equal(shouldTrackHost('172.16.0.1'), false)
  // 任何纯 IP 都跳过（先被 IP 规则拦下，不管是不是私有段）
  assert.equal(shouldTrackHost('8.8.8.8'), false)
  assert.equal(shouldTrackHost('172.32.0.1'), false)
  // 域名照常统计
  assert.equal(shouldTrackHost('api.example.com'), true)
})
