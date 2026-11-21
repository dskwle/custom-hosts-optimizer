import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// @ts-ignore TS5097 —— node --experimental-strip-types 只认显式 .ts 后缀；tsconfig 未开 allowImportingTsExtensions
import { summarize } from './advice.ts'
import type { CapturedRequest, HostSummary, Verdict } from './types'

interface Fixture {
  url: string
  requests: CapturedRequest[]
}

function load(name: string): { pageHost: string; requests: CapturedRequest[] } {
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const parsed = JSON.parse(raw) as Fixture
  return { pageHost: new URL(parsed.url).hostname, requests: parsed.requests }
}

function distribution(summaries: HostSummary[]): Record<Verdict, number> {
  const acc: Record<Verdict, number> = { accel: 0, block: 0, proxy: 0, ignore: 0, unknown: 0 }
  for (const s of summaries) acc[s.verdict] += 1
  return acc
}

function pick(summaries: HostSummary[], host: string): HostSummary {
  const found = summaries.find((s) => s.host === host)
  assert.ok(found, `fixture 里缺少域名 ${host}`)
  return found
}

test('fixture：正常站，零建议（对照组）', () => {
  const { pageHost, requests } = load('normal-site.json')
  const summaries = summarize(requests, { pageHost })
  assert.equal(summaries.length, 6)
  assert.deepEqual(distribution(summaries), { accel: 0, block: 0, proxy: 0, ignore: 0, unknown: 6 })
  assert.equal(summaries.filter((s) => s.suggested).length, 0)
  for (const s of summaries) assert.ok(s.reason.length > 0)
})

test('fixture：广告多的资讯站，第三方慢域名被建议加速、失败域名被建议屏蔽', () => {
  const { pageHost, requests } = load('news-ads.json')
  const summaries = summarize(requests, { pageHost })
  assert.equal(pageHost, 'news.example.co.uk')
  assert.equal(summaries.length, 12)
  assert.deepEqual(distribution(summaries), { accel: 5, block: 2, proxy: 0, ignore: 1, unknown: 4 })

  // 多级后缀：同 registrable domain 判第一方
  assert.equal(pick(summaries, 'static.example.co.uk').thirdParty, false)
  assert.equal(pick(summaries, 'cdn.ads-network.co.uk').thirdParty, true)

  const blocked = summaries.filter((s) => s.verdict === 'block').map((s) => s.host).sort()
  assert.deepEqual(blocked, ['analytics.segment.io', 'tracker.adnetwork.com'])
  for (const s of summaries.filter((x) => x.verdict === 'block')) assert.equal(s.suggested, true)

  assert.equal(pick(summaries, 'cdn.ads-network.co.uk').verdict, 'accel')
  assert.equal(pick(summaries, 'ads.doubleclick.net').verdict, 'accel')
  // 第一方慢域名不进 hosts：改 hosts 无解
  assert.equal(pick(summaries, 'cdn.example.co.uk').verdict, 'ignore')
  assert.equal(pick(summaries, 'cdn.example.co.uk').suggested, false)

  // 缓存命中不产生耗时，因此不判慢
  assert.equal(pick(summaries, 'ssl.gstatic.com').p95TtfbMs, undefined)
  assert.equal(pick(summaries, 'ssl.gstatic.com').verdict, 'unknown')
})

test('fixture：视频站，媒体 CDN 慢建议加速，第一方流地址不动 hosts', () => {
  const { pageHost, requests } = load('video-site.json')
  const summaries = summarize(requests, { pageHost })
  assert.equal(summaries.length, 9)
  assert.deepEqual(distribution(summaries), { accel: 2, block: 0, proxy: 0, ignore: 2, unknown: 5 })

  assert.equal(pick(summaries, 'cdn.video-cdn.net').verdict, 'accel')
  assert.equal(pick(summaries, 'cdn.video-cdn.net').p95TtfbMs, 5200)
  assert.equal(pick(summaries, 'player.vimeo.com').verdict, 'accel')

  assert.equal(pick(summaries, 'stream.example.com').verdict, 'ignore')
  assert.match(pick(summaries, 'stream.example.com').reason, /改 hosts 可能无解/)
  assert.equal(pick(summaries, 'api.example.com').verdict, 'ignore')
  assert.match(pick(summaries, 'api.example.com').reason, /需排查源站/)
})

test('fixture：SNI 阻断时整站强制 proxy，且一条都不勾选', () => {
  const { pageHost, requests } = load('video-site.json')
  const summaries = summarize(requests, { pageHost, sniBlocked: true })
  assert.equal(summaries.length, 9)
  assert.deepEqual(distribution(summaries), { accel: 0, block: 0, proxy: 9, ignore: 0, unknown: 0 })
  assert.equal(summaries.filter((s) => s.suggested).length, 0)
  for (const s of summaries) assert.match(s.reason, /SNI 阻断/)
})

test('fixture：三个场景的聚合结构都满足契约字段要求', () => {
  for (const name of ['normal-site.json', 'news-ads.json', 'video-site.json']) {
    const { pageHost, requests } = load(name)
    const summaries = summarize(requests, { pageHost })
    assert.ok(summaries.length > 0, `${name} 未产出 summary`)
    assert.equal(summaries.reduce((sum, s) => sum + s.requests, 0), requests.length)
    for (const s of summaries) {
      assert.ok(s.host.length > 0)
      assert.ok(s.requests > 0)
      assert.ok(s.failures <= s.requests)
      assert.ok(s.bytes >= 0)
      assert.ok(s.kinds.length > 0, `${s.host} 缺少 kinds`)
      assert.ok(s.reason.length > 0, `${s.host} 缺少 reason`)
      assert.equal(typeof s.thirdParty, 'boolean')
      assert.equal(s.suggested, s.verdict === 'block' || s.verdict === 'accel')
    }
  }
})