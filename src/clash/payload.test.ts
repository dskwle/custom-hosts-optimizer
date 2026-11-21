/**
 * payload 生成的单测：去重、排序、非法项剔除、exclude、空输出。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildDomainPayload, formatPayloadYaml, normalizeRuleDomain } from "./payload.ts"

test("域名去重不区分大小写，结果按字典序", () => {
  const r = buildDomainPayload(["b.example.com", "A.example.com", "a.example.com", "b.example.com"])
  assert.deepEqual(r.domains, ["a.example.com", "b.example.com"])
  assert.deepEqual(r.skipped, [])
})

test("从 URL / 带端口 / 通配前缀的写法里抽出裸域名", () => {
  assert.equal(normalizeRuleDomain("https://ads.example.com/path?x=1"), "ads.example.com")
  assert.equal(normalizeRuleDomain("ads.example.com:8080"), "ads.example.com")
  assert.equal(normalizeRuleDomain("*.tracker.io"), "tracker.io")
  assert.equal(normalizeRuleDomain("  TRACKER.io.  "), "tracker.io")
})

test("通配符残留、IP、注释、空行都判为非法", () => {
  assert.equal(normalizeRuleDomain("*ads.example.com"), null)
  assert.equal(normalizeRuleDomain("a*b.example.com"), null)
  assert.equal(normalizeRuleDomain("1.1.1.1"), null)
  assert.equal(normalizeRuleDomain("2001:db8::1"), null)
  assert.equal(normalizeRuleDomain("# comment"), null)
  assert.equal(normalizeRuleDomain("!"), null)
  assert.equal(normalizeRuleDomain(""), null)
})

test("非法项进 skipped，不静默丢弃", () => {
  const r = buildDomainPayload(["ok.example.com", "1.1.1.1", "a_b.example.com"])
  assert.deepEqual(r.domains, ["ok.example.com"])
  assert.deepEqual(r.skipped, ["1.1.1.1", "a_b.example.com"])
})

test("exclude 命中时不重复输出（ads 与 block 去重）", () => {
  const r = buildDomainPayload(["dup.example.com", "only-ads.example.com"], {
    exclude: ["DUP.example.com"],
  })
  assert.deepEqual(r.domains, ["only-ads.example.com"])
})

test("空 payload 输出合法 YAML", () => {
  const yaml = formatPayloadYaml([])
  assert.match(yaml, /^payload: \[\]$/m)
  const doc = formatPayloadYaml(buildDomainPayload([]).domains)
  assert.match(doc, /^payload: \[\]$/m)
})

test("payload 条目为带引号的域名列表", () => {
  const yaml = formatPayloadYaml(["a.example.com", "b.example.com"])
  assert.match(yaml, /^payload:$/m)
  assert.match(yaml, /^ {2}- 'a\.example\.com'$/m)
  assert.match(yaml, /^ {2}- 'b\.example\.com'$/m)
  // 不能出现 hosts 式的地址前缀（behavior: domain 只认裸域名）
  assert.doesNotMatch(yaml, /0\.0\.0\.0/)
})
