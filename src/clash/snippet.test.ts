/**
 * snippet / example config 的单测。
 *
 * 这些 YAML 是给用户直接粘进 mihomo 的，最容易出错的三处固定下来：
 * url 拼接（末尾斜杠）、proxy-group 名替换、interval。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildClashHosts } from "./hosts.ts"
import { buildExampleConfigYaml, buildSnippetYaml } from "./snippet.ts"

const hosts = buildClashHosts([
  ["203.0.113.10", "github.com"],
  ["2001:db8::1", "api.github.com"],
])

test("snippet 同时包含 hosts / rule-providers / rules 三段", () => {
  const yaml = buildSnippetYaml({ baseUrl: "http://192.168.1.10:8788", hosts })
  const idxHosts = yaml.indexOf("\nhosts:")
  const idxProviders = yaml.indexOf("\nrule-providers:")
  const idxRules = yaml.indexOf("\nrules:")
  assert.ok(idxHosts > 0, "缺少 hosts 段")
  assert.ok(idxProviders > idxHosts, "rule-providers 段位置不对")
  assert.ok(idxRules > idxProviders, "rules 段位置不对")
})

test("provider url 指向本服务且不出现双斜杠", () => {
  const yaml = buildSnippetYaml({ baseUrl: "http://192.168.1.10:8788/", hosts })
  assert.match(yaml, /url: "http:\/\/192\.168\.1\.10:8788\/clash\/block\.yaml"/)
  assert.match(yaml, /url: "http:\/\/192\.168\.1\.10:8788\/clash\/ads\.yaml"/)
  assert.match(yaml, /url: "http:\/\/192\.168\.1\.10:8788\/clash\/proxy\.yaml"/)
  assert.doesNotMatch(yaml, /8788\/\/clash/)
})

test("interval 固定 7200，三条规则顺序固定", () => {
  const yaml = buildSnippetYaml({ baseUrl: "http://127.0.0.1:8788", hosts })
  assert.equal((yaml.match(/interval: 7200/g) ?? []).length, 3)
  const rules = yaml.slice(yaml.indexOf("\nrules:"))
  assert.ok(rules.indexOf("RULE-SET,ch-block,REJECT") < rules.indexOf("RULE-SET,ch-ads,REJECT"))
  assert.ok(rules.indexOf("RULE-SET,ch-ads,REJECT") < rules.indexOf("RULE-SET,ch-proxy,PROXY"))
})

test("自定义策略组名会替换掉 PROXY 那一条", () => {
  const yaml = buildSnippetYaml({
    baseUrl: "http://127.0.0.1:8788",
    hosts,
    proxyGroup: " 节点选择 ",
  })
  assert.match(yaml, /RULE-SET,ch-proxy,节点选择/)
  assert.doesNotMatch(yaml, /RULE-SET,ch-proxy,PROXY/)
  assert.match(yaml, /节点选择 必须改成你自己的策略组名/)
})

test("没有 hosts 数据时仍是合法 YAML（hosts: {}）", () => {
  const yaml = buildSnippetYaml({ baseUrl: "http://127.0.0.1:8788" })
  assert.match(yaml, /^hosts: \{\}$/m)
})

test("example config 含 dns.use-hosts、fake-ip、tun 注释与策略组占位", () => {
  const yaml = buildExampleConfigYaml({ baseUrl: "http://127.0.0.1:8788", hosts })
  assert.match(yaml, /^dns:$/m)
  assert.match(yaml, /^ {2}enable: true$/m)
  assert.match(yaml, /^ {2}use-hosts: true$/m)
  assert.match(yaml, /^ {2}enhanced-mode: fake-ip$/m)
  // tun 必须是注释状态：默认开启会让部分环境直接起不来
  assert.match(yaml, /^# tun:$/m)
  assert.match(yaml, /^proxy-groups:$/m)
  assert.match(yaml, /^ {2}- name: PROXY$/m)
  assert.match(yaml, /^ {2}- GEOIP,CN,DIRECT$/m)
  // hosts 与规则同样要带上，模板才可独立使用
  assert.match(yaml, /"github\.com":/)
  assert.match(yaml, /RULE-SET,ch-block,REJECT/)
})
