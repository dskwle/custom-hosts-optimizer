#!/usr/bin/env node
/**
 * 在 deploy 之前把 wrangler.toml 里的 KV 占位符替换成真实命名空间 ID。
 *
 * 为什么需要这个脚本：
 *   wrangler 不会解析 wrangler.toml 里的环境变量，占位符会被原样发给 Cloudflare API，
 *   导致 "KV namespace 'YOUR_KV_NAMESPACE_ID' is not valid [code: 10042]"。
 *
 * ID 来源优先级：
 *   1. 环境变量 KV_NAMESPACE_ID（Cloudflare Workers Builds / GitHub Actions 用这个）
 *   2. 本地 .dev.vars 中的 KV_NAMESPACE_ID（本地 pnpm deploy 用这个）
 *
 * 已经填了真实 ID（32 位十六进制）时直接跳过，可安全重复执行。
 * 只改写 id / preview_id 的值，不碰注释里的文字。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CONFIG = 'wrangler.toml'
const PLACEHOLDER = 'YOUR_KV_NAMESPACE_ID'
const VALID_ID = /^[0-9a-fA-F]{32}$/

// 只匹配行首的 id = "..." 或 preview_id = "..."，避免误伤注释里的同名文字
const ID_LINE = /^([ \t]*(?:preview_)?id[ \t]*=[ \t]*)"([^"]*)"/gm

function readDevVars() {
  if (!existsSync('.dev.vars')) return null
  const line = readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('KV_NAMESPACE_ID='))
  if (!line) return null
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

if (!existsSync(CONFIG)) {
  console.error(`[inject-kv] 找不到 ${CONFIG}，无法注入 KV ID`)
  process.exit(1)
}

const toml = readFileSync(CONFIG, 'utf8')
const currentIds = [...toml.matchAll(ID_LINE)].map((m) => m[2])

if (currentIds.length === 0) {
  console.error(`[inject-kv] ${CONFIG} 里没有找到 id / preview_id 配置，请检查 [[kv_namespaces]] 段`)
  process.exit(1)
}

if (currentIds.every((v) => VALID_ID.test(v))) {
  console.log('[inject-kv] wrangler.toml 已是真实 KV ID，跳过注入')
  process.exit(0)
}

const kvId = (process.env.KV_NAMESPACE_ID || readDevVars() || '').trim()

if (!kvId) {
  console.error(`
[inject-kv] 注入失败：${CONFIG} 里仍有占位符 ${PLACEHOLDER}，但没有拿到真实 ID。

请任选一种方式提供：
  A. Cloudflare Workers Builds（Git 集成部署）
     Workers & Pages -> 你的 Worker -> Settings -> Build -> Variables and Secrets
     新增变量 KV_NAMESPACE_ID = <32 位命名空间 ID>

  B. GitHub Actions
     仓库 Settings -> Secrets and variables -> Actions -> 新增 KV_NAMESPACE_ID

  C. 本机开发
     在项目根目录 .dev.vars 里写 KV_NAMESPACE_ID=<ID>，
     或直接 export KV_NAMESPACE_ID=<ID>

拿 ID 的方式：
  npx wrangler kv namespace list
  或 Dashboard -> Workers & Pages -> KV -> 选中命名空间 -> 右侧 Namespace ID
`)
  process.exit(1)
}

if (!VALID_ID.test(kvId)) {
  console.error(
    `[inject-kv] KV_NAMESPACE_ID 格式不正确，应为 32 位十六进制，实际收到 ${kvId.length} 个字符：${kvId}`
  )
  process.exit(1)
}

const patched = toml.replace(ID_LINE, (_m, prefix) => `${prefix}"${kvId}"`)
writeFileSync(CONFIG, patched)

const masked = `${kvId.slice(0, 6)}...${kvId.slice(-4)}`
console.log(`[inject-kv] 已注入 KV_NAMESPACE_ID (${masked})，影响 ${currentIds.length} 处配置`)
