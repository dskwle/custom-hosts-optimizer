/**
 * buildClashHosts / formatClashHostsYaml 的单测。
 *
 * 关注点全是"错了会让用户网络直接坏掉"的路径：
 * 域名重复、v4/v6 混排、屏蔽域名混进 hosts、脏数据导致整份配置加载失败。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildClashHosts,
  formatClashHostsYaml,
  isIPv4,
  isIPv6,
  normalizeHostDomain,
} from "./hosts.ts"

test("同一域名的多条记录合并，地址去重且保留顺序", () => {
  const r = buildClashHosts([
    ["1.1.1.1", "github.com"],
    ["1.1.1.1", "github.com"],
    ["203.0.113.10", "GitHub.com"],
  ])
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].domain, "github.com")
  assert.deepEqual(r.entries[0].ips, ["1.1.1.1", "203.0.113.10"])
  assert.equal(r.stats.domains, 1)
  assert.equal(r.stats.ips, 2)
})

test("IPv6 与 IPv4 混排：两族都要保留，不能只留一个", () => {
  const r = buildClashHosts([
    ["203.0.113.11", "api.github.com"],
    ["2001:db8::1", "api.github.com"],
    ["203.0.113.12", "raw.githubusercontent.com"],
  ])
  assert.equal(r.entries.length, 2)
  const api = r.entries.find((e) => e.domain === "api.github.com")
  assert.deepEqual(api?.ips, ["203.0.113.11", "2001:db8::1"])
  assert.equal(r.stats.ips, 3)
})

test("屏蔽域名不进 hosts（大小写与尾部点都能匹配）", () => {
  const r = buildClashHosts(
    [
      ["1.1.1.1", "ads.example.com"],
      ["1.1.1.1", "Ads.Example.com."],
      ["203.0.113.13", "safe.example.com"],
    ],
    { blocked: ["ads.example.com"] }
  )
  assert.deepEqual(
    r.entries.map((e) => e.domain),
    ["safe.example.com"]
  )
  assert.equal(r.stats.blocked, 2)
})

test("非法域名与非法地址被丢弃，不会污染输出", () => {
  const r = buildClashHosts([
    ["1.1.1.1", "*.example.com"], // 通配
    ["1.1.1.1", "bad_domain.example"], // 下划线
    ["1.1.1.1", "no-dot"], // 没有点
    ["not-an-ip", "ok.example.com"], // 地址非法
    ["1.1.1.1", "ok.example.com"],
  ])
  assert.equal(r.stats.invalidDomain, 3)
  assert.equal(r.stats.invalidIp, 1)
  assert.deepEqual(
    r.entries.map((e) => e.domain),
    ["ok.example.com"]
  )
})

test("空数据输出合法的空映射而非 null", () => {
  const yaml = formatClashHostsYaml(buildClashHosts([]))
  assert.match(yaml, /^hosts: \{\}$/m)
})

test("输出的域名键与地址值都带引号", () => {
  const yaml = formatClashHostsYaml(
    buildClashHosts([
      ["1.1.1.1", "github.com"],
      ["2001:db8::1", "github.com"],
    ])
  )
  assert.match(yaml, /^ {2}"github\.com":$/m)
  assert.match(yaml, /^ {4}- '1\.1\.1\.1'$/m)
  assert.match(yaml, /^ {4}- '2001:db8::1'$/m)
})

test("updatedAt 合法时写进注释，非法或缺失时不写", () => {
  const base = buildClashHosts([["1.1.1.1", "github.com"]])
  const withTs = formatClashHostsYaml(base, { updatedAt: "2026-11-21T02:00:00.000Z" })
  assert.match(withTs, /数据更新时间：/)
  const noTs = formatClashHostsYaml(base, { updatedAt: "not-a-date" })
  assert.doesNotMatch(noTs, /数据更新时间/)
})

test("域名与地址校验的边界", () => {
  assert.equal(normalizeHostDomain(" GitHub.COM. "), "github.com")
  assert.equal(normalizeHostDomain(""), null)
  assert.equal(normalizeHostDomain("a"), null)
  assert.equal(isIPv4("255.255.255.255"), true)
  assert.equal(isIPv4("256.0.0.1"), false)
  assert.equal(isIPv4("2001:db8::1"), false)
  assert.equal(isIPv6("2001:db8::1"), true)
  assert.equal(isIPv6("fe80::1%en0"), true)
  assert.equal(isIPv6("1.2.3.4"), false)
})
