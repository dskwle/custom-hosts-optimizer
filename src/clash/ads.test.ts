/**
 * 广告规则解析的单测。
 *
 * 上游缓存是 hosts 写法（v4/v6 各一行），这里验证同一个域名只会出现一次，
 * 且 localhost / 通配 / 注释不会漏进 payload——这些漏进去就是用户本地服务断掉。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatAdsYaml, parseAdsDomains } from "./ads.ts"

const SAMPLE = [
  "# AWAvenue-Ads-Rule（示例）",
  "! AdGuard 风格注释",
  "0.0.0.0 ads.example.com",
  ":: ads.example.com",
  "0.0.0.0 tracker.example.io",
  ":: tracker.example.io",
  "0.0.0.0 localhost",
  "::1 localhost",
  "0.0.0.0 ads.example.com",
  "0.0.0.0 *.wild.example.net",
  "",
].join("\n")

test("同一域名的 v4 / v6 两行只输出一次", () => {
  const domains = parseAdsDomains(SAMPLE)
  assert.deepEqual(domains, ["ads.example.com", "tracker.example.io"])
})

test("localhost、通配符与注释被剔除", () => {
  const domains = parseAdsDomains(SAMPLE)
  assert.ok(!domains.includes("localhost"))
  assert.ok(!domains.some((d) => d.includes("*")))
})

test("单列裸域名也能解析（上游换格式时不至于全空）", () => {
  assert.deepEqual(parseAdsDomains("a.example.com\nb.example.com"), [
    "a.example.com",
    "b.example.com",
  ])
})

test("空内容返回空数组而不是抛错", () => {
  assert.deepEqual(parseAdsDomains(""), [])
  assert.deepEqual(parseAdsDomains("\n\n# only comment\n"), [])
})

test("formatAdsYaml：与屏蔽清单重叠的域名被排除，计数正确", () => {
  const { yaml, count } = formatAdsYaml(SAMPLE, {
    fetchedAt: "2026-11-21T02:00:00.000Z",
    version: "1.0.204",
    exclude: ["ads.example.com"],
  })
  assert.equal(count, 1)
  assert.match(yaml, /- 'tracker\.example\.io'/)
  assert.doesNotMatch(yaml, /- 'ads\.example\.com'/)
  assert.match(yaml, /抓取时间：/)
  assert.match(yaml, /上游版本：1\.0\.204/)
})

test("formatAdsYaml：没有缓存时输出 payload: [] 并说明原因", () => {
  const { yaml, count } = formatAdsYaml(null)
  assert.equal(count, 0)
  assert.match(yaml, /^payload: \[\]$/m)
  assert.match(yaml, /请先在控制台刷新一次/)
})
