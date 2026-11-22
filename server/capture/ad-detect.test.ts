/**
 * 广告识别单测。
 *
 * 误判代价不对称：漏掉广告只是多看一眼，错杀资源会让页面坏掉。
 * 所以这里重点验证"不该判成广告"的边界，尤其是站点自己的统计子域、
 * 正常 CDN、以及只有路径特征的弱信号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectAd, hostMatchesSuffix } from './ad-detect.ts'

const knownAds = new Set([
  'doubleclick.net',
  '1rtb.com',
  'google-analytics.com',
])

test('后缀匹配：子域命中父域，相似域名不误伤', () => {
  assert.equal(hostMatchesSuffix('ssl.1rtb.com', '1rtb.com'), true)
  assert.equal(hostMatchesSuffix('1rtb.com', '1rtb.com'), true)
  assert.equal(hostMatchesSuffix('not1rtb.com', '1rtb.com'), false)
  assert.equal(hostMatchesSuffix('1rtb.com.evil.net', '1rtb.com'), false)
})

test('命中已启用广告清单 → high，建议屏蔽', () => {
  const r = detectAd({ host: 'ad.doubleclick.net', thirdParty: true, knownAds })
  assert.equal(r.isAd, true)
  assert.equal(r.strength, 'high')
  assert.match(r.signals[0], /广告规则/)
})

test('清单里没有但域名带广告服务商标识 → medium', () => {
  const r = detectAd({ host: 'securepubads.g.doubleclick.net', thirdParty: true })
  assert.equal(r.isAd, true)
  assert.equal(r.strength, 'medium')
  assert.match(r.signals[0], /广告服务商/)
})

test('ads. 子域前缀 → medium，即使是一方也判', () => {
  const r = detectAd({ host: 'ads.example.com', thirdParty: false })
  assert.equal(r.isAd, true)
  assert.equal(r.strength, 'medium')
})

test('一方站点自己的 analytics 子域不判广告', () => {
  // 这是最容易误伤的：站点自己的统计，屏蔽会让页面报表挂掉
  const r = detectAd({ host: 'analytics.example.com', thirdParty: false })
  assert.equal(r.isAd, false)
})

test('第三方 analytics 子域 → medium', () => {
  const r = detectAd({ host: 'analytics.vendor.com', thirdParty: true })
  assert.equal(r.isAd, true)
  assert.equal(r.strength, 'medium')
})

test('第三方 + 追踪词 → medium', () => {
  const r = detectAd({ host: 'ct.pixel-tracker.io', thirdParty: true })
  assert.equal(r.isAd, true)
})

test('一方 + 追踪词不判（避免误伤自家埋点）', () => {
  const r = detectAd({ host: 'telemetry.example.com', thirdParty: false })
  assert.equal(r.isAd, false)
})

test('正常 CDN / 静态资源不判广告', () => {
  for (const h of ['static.licdn.com', 'images.unsplash.com', 'cdn.jsdelivr.net', 'yt4.ggpht.com']) {
    const r = detectAd({ host: h, thirdParty: true })
    assert.equal(r.isAd, false, `${h} 不该判成广告`)
  }
})

test('只有路径特征 → low，不建议屏蔽', () => {
  const r = detectAd({
    host: 'cdn.example.com',
    url: 'https://cdn.example.com/banner/promo.png',
    thirdParty: true,
  })
  assert.equal(r.isAd, false)
  assert.equal(r.strength, 'low')
  assert.match(r.signals[0], /路径/)
})

test('路径特征不会覆盖 high：清单命中优先', () => {
  const r = detectAd({
    host: 'pagead2.googlesyndication.com',
    url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    thirdParty: true,
    knownAds: new Set([...knownAds, 'googlesyndication.com']),
  })
  assert.equal(r.strength, 'high')
})

test('空 host 不崩', () => {
  const r = detectAd({ host: '', thirdParty: false })
  assert.equal(r.isAd, false)
  assert.equal(r.strength, null)
})

test('非法 URL 不崩，退回域名判定', () => {
  const r = detectAd({ host: 'ads.foo.com', url: 'not a url', thirdParty: true })
  assert.equal(r.isAd, true)
})

test('signals 始终可读（中文）', () => {
  for (const h of ['ad.doubleclick.net', 'ads.foo.com', 'x.1rtb.com']) {
    const r = detectAd({ host: h, thirdParty: true, knownAds })
    assert.ok(r.signals.length > 0, `${h} 应有依据`)
    assert.match(r.signals[0], /[\u4e00-\u9fa5]/, `${h} 的依据应是中文`)
  }
})
