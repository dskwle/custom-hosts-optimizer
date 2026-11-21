#!/usr/bin/env node
/**
 * 抓包后端自测：start → 等页面加载 → summary → stop，并顺手验错误码。
 *
 * 为什么需要它：NAS 上的真实验收要开 noVNC 容器，本地开发时连不上 9223。
 * 这个脚本在本机用一个 headless Chrome 走完整流程，**只验证逻辑**——
 * headless 的 CDP 绑定行为与生产不同（生产是 host 网络 + 真有头），
 * 能不能出画面由 scripts/orch/capture-smoke.sh 负责。
 *
 * 用法：
 *   # 终端 1：起一个带调试端口的 Chrome（脚本也能替你起：加 --launch）
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-b about:blank
 *
 *   # 终端 2：
 *   node scripts/orch/capture-selftest.mjs --url https://www.debian.org --wait 4000
 *   node scripts/orch/capture-selftest.mjs --launch --url https://github.com
 *   node scripts/orch/capture-selftest.mjs --cdp http://127.0.0.1:9 --only-errors
 *
 * 参数：--cdp（默认 http://127.0.0.1:9222）/ --url / --wait（毫秒）/ --port /
 *       --store-urls / --launch / --only-errors / --keep（保留临时构建产物）
 *
 * 退出码：0 全通过，1 有断言失败。
 */

import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const CDP_URL = arg('cdp', 'http://127.0.0.1:9222')
const TARGET_URL = arg('url', 'https://www.debian.org')
const WAIT_MS = Number(arg('wait', 4000))
const PORT = Number(arg('port', 8897))
const STORE_URLS = flag('store-urls')
const ONLY_ERRORS = flag('only-errors')
const KEEP = flag('keep')
const LAUNCH = flag('launch')

const BASE = `http://127.0.0.1:${PORT}/local/capture`

let failures = 0
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`)
const bad = (msg) => {
  failures += 1
  console.log(`\x1b[31m✗\x1b[0m ${msg}`)
}
const info = (msg) => console.log(`· ${msg}`)
const head = (msg) => console.log(`\n== ${msg} ==`)

function expect(cond, msg, detail) {
  if (cond) ok(msg)
  else bad(`${msg}${detail ? `（实际：${JSON.stringify(detail)}）` : ''}`)
}

// ---------------------------------------------------------------- 临时 Chrome

let chromeProc = null

function findChrome() {
  const explicit = arg('chrome', '')
  if (explicit) return explicit
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  // Edge 也是 Chromium，CDP 协议一致；Mac 开发机上常常只有它
  return (
    [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ].find((p) => existsSync(p)) || ''
  )
}

async function launchChrome() {
  const bin = findChrome()
  const profile = path.join(os.tmpdir(), `chs-selftest-chrome-${process.pid}`)
  const port = new URL(CDP_URL).port || '9222'
  info(`启动 headless Chrome：${bin}（profile ${profile}）`)
  chromeProc = spawn(
    bin,
    [
      '--headless=new',
      // 本机开发环境（CI/沙箱/部分企业 MDM）里 Chromium 自带的 sandbox 起不来，
      // GPU 进程会连带崩掉，表现为"Network.enable 无响应 / WS 1006 断开"。
      // 只影响这个开发脚本；生产容器里的浏览器由 entrypoint 自己管。
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  chromeProc.on('error', (err) => bad(`Chrome 启动失败：${err.message}`))

  // 等 /json/version 起来
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${CDP_URL}/json/version`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  bad(`Chrome 在 ${CDP_URL} 上没起来`)
}

// ---------------------------------------------------------------- 用假 KV 起一个最小服务

/**
 * 不直接跑 dist-server/index.mjs：那样得改 server/index.ts 的挂载（本 lane 不允许），
 * 而且真实 KV 会往 data/ 里写东西。这里用 esbuild 把路由单独打成临时模块，
 * 挂在内存 KV 上，测完即弃。
 */
async function buildRoutes() {
  const shim = {
    name: 'cf-sockets-shim',
    setup(build) {
      build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
        path: path.resolve(root, 'server/shims/cloudflare-sockets.ts'),
      }))
    },
  }
  const out = await esbuild.build({
    stdin: {
      contents: [
        `import { Hono } from 'hono'`,
        `export { Hono }`,
        `export { createCaptureRoutes } from './server/routes/capture.ts'`,
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'capture-selftest-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    plugins: [shim],
    external: ['node:*'],
    logLevel: 'silent',
  })
  const file = path.join(os.tmpdir(), `chs-capture-routes-${process.pid}.mjs`)
  await fs.writeFile(file, out.outputFiles[0].text, 'utf8')
  return file
}

/** 与 server/kv.ts 的 FileKV 签名一致的内存实现 */
function memoryKV() {
  const store = new Map()
  return {
    async get(key, options) {
      const value = store.get(key)
      if (value == null) return null
      const asJson = options === 'json' || options?.type === 'json'
      return asJson ? JSON.parse(value) : value
    },
    async put(key, value) {
      store.set(key, String(value))
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

// ---------------------------------------------------------------- HTTP 小工具

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text }
}

/**
 * 后台消费 SSE，收集帧。
 * 手动解析 `data: ` 行而不是找现成库：SSE 的格式就这么三行，
 * 而且这里正好可以顺手验证 15s 保活的注释行不会把解析搞崩。
 */
function consumeStream(sessionId) {
  const frames = []
  let raw = ''
  const abort = new AbortController()
  const state = { endedAt: 0, closedAt: 0 }
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/${sessionId}/stream`, { signal: abort.signal })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        raw += decoder.decode(value, { stream: true })
        let idx
        while ((idx = raw.indexOf('\n\n')) >= 0) {
          const chunk = raw.slice(0, idx)
          raw = raw.slice(idx + 2)
          if (chunk.startsWith(':')) continue // 保活注释行
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const frame = JSON.parse(line.slice(6))
              frames.push(frame)
              if (frame.type === 'end') state.endedAt = Date.now()
            } catch {
              /* 半帧忽略 */
            }
          }
        }
      }
      state.closedAt = Date.now()
    } catch {
      /* abort 是正常的收尾方式 */
    }
  })()
  return { frames, state, close: () => abort.abort(), done }
}

// ---------------------------------------------------------------- 主流程

async function runErrors(base) {
  head('错误码（CDP 不可达场景）')
  const empty = await base('POST', '/start', { url: '' })
  expect(empty.status === 400 && empty.json?.error, '空 url → 400', empty.json)
  const badScheme = await base('POST', '/start', { url: 'ftp://example.com/x' })
  expect(badScheme.status === 400, '非 http(s) → 400', badScheme.json)
  const missing = await base('GET', '/capture-does-not-exist')
  expect(missing.status === 404 && missing.json?.error === 'session not found', '未知会话 → 404', missing.json)
  const stopMissing = await base('POST', '/capture-does-not-exist/stop')
  expect(stopMissing.status === 404, '停止未知会话 → 404', stopMissing.json)
  const noHosts = await base('POST', '/apply', { hosts: [], action: 'block' })
  expect(noHosts.status === 400, 'apply 空 hosts → 400', noHosts.json)
  const start = await base('POST', '/start', { url: 'https://example.com' })
  expect(
    start.status === 502 && start.json?.error === 'Chromium 未就绪（CDP 连接失败）',
    'CDP 不可达 → 502 且文案与契约一致',
    { status: start.status, body: start.json },
  )
}

async function runFlow(base) {
  head(`开始抓包：${TARGET_URL}`)

  // 先扮演"用户自己开着的标签页"，用来验证 stop 只关抓包自己开的那一个。
  // 这是最容易出人命的地方：误关会把用户没保存的页面关掉。
  const userTab = await fetch(`${CDP_URL}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  const pagesBefore = await fetch(`${CDP_URL}/json/list`)
    .then((r) => r.json())
    .then((list) => list.filter((t) => t.type === 'page'))
    .catch(() => [])
  if (userTab) info(`模拟用户标签页：${userTab.id}`)

  const started = await base('POST', '/start', { url: TARGET_URL, storeUrls: STORE_URLS })
  const t0 = Date.now()
  if (started.status !== 200 || !started.json?.session) {
    bad(`start 失败：${started.status} ${started.text.slice(0, 200)}`)
    return
  }
  const session = started.json.session
  ok(`start → ${session.id}（status=${session.status}）`)

  // 单会话约束：运行中再 start 必须 409
  const conflict = await base('POST', '/start', { url: 'https://example.com' })
  expect(conflict.status === 409 && conflict.json?.error === '已有抓包会话在运行', '重复 start → 409', conflict.json)

  const stream = consumeStream(session.id)
  // 不能 await stream.done：SSE 要等会话结束才关，await 会把流程卡死在这里
  await new Promise((r) => setTimeout(r, 300))

  info(`等页面加载 ${WAIT_MS}ms …`)
  await new Promise((r) => setTimeout(r, WAIT_MS))

  head('汇总')
  const summary = await base('GET', `/${session.id}/summary`)
  if (summary.status !== 200 || !Array.isArray(summary.json?.hosts)) {
    bad(`summary 失败：${summary.status} ${summary.text.slice(0, 200)}`)
  } else {
    const hosts = summary.json.hosts
    const totalRequests = hosts.reduce((sum, h) => sum + h.requests, 0)
    ok(`summary 返回 ${hosts.length} 个域名、共 ${totalRequests} 条请求`)
    expect(hosts.length >= 1, '域名数 ≥ 1', hosts.length)
    expect(hosts.length <= 200, '域名数 ≤ 200（量级与 DevTools 一致）', hosts.length)

    const slow = hosts
      .filter((h) => h.p95TtfbMs != null || h.p95TotalMs != null)
      .slice()
      .sort((a, b) => Math.max(b.p95TtfbMs ?? 0, b.p95TotalMs ?? 0) - Math.max(a.p95TtfbMs ?? 0, a.p95TotalMs ?? 0))
      .slice(0, 5)
    console.log('\n  top5 慢域名（p95）：')
    for (const h of slow) {
      console.log(
        `    ${h.host.padEnd(34)} 请求 ${String(h.requests).padEnd(3)} ` +
          `p95 ttfb ${String(h.p95TtfbMs ?? '-').padStart(6)}ms ` +
          `p95 total ${String(h.p95TotalMs ?? '-').padStart(6)}ms ` +
          `verdict=${h.verdict}${h.thirdParty ? ' 第三方' : ''}`,
      )
    }
    const verdicts = hosts.reduce((acc, h) => {
      acc[h.verdict] = (acc[h.verdict] ?? 0) + 1
      return acc
    }, {})
    info(`verdict 分布：${JSON.stringify(verdicts)}`)
  }

  head('详情与停止')
  const detail = await base('GET', `/${session.id}`)
  const requestCount = detail.json?.requests?.length ?? 0
  ok(`详情返回 ${requestCount} 条请求（session.requestCount=${detail.json?.session?.requestCount}）`)
  expect(requestCount >= 1, '请求明细 ≥ 1', requestCount)
  if (!STORE_URLS && detail.json?.requests?.some((r) => r.url)) {
    bad('隐私默认：storeUrls=false 时不应返回 url 字段')
  } else if (!STORE_URLS) {
    ok('隐私默认：未存 url')
  }

  const stop = await base('POST', `/${session.id}/stop`)
  const elapsed = Date.now() - t0
  expect(stop.status === 200 && stop.json?.session?.status === 'stopped', 'stop → status=stopped', stop.json)

  // 停止后再 stop 应幂等（走磁盘）
  const stopAgain = await base('POST', `/${session.id}/stop`)
  expect(stopAgain.status === 200, '重复 stop 幂等', stopAgain.status)

  head('标签页清理（不误伤用户其它标签页）')
  const pagesAfter = await fetch(`${CDP_URL}/json/list`)
    .then((r) => r.json())
    .then((list) => list.filter((t) => t.type === 'page'))
    .catch(() => [])
  if (userTab) {
    expect(
      pagesAfter.some((t) => t.id === userTab.id),
      '用户已有标签页仍在（没被误关）',
      pagesAfter.map((t) => t.id),
    )
  }
  expect(
    pagesAfter.length === pagesBefore.length,
    `抓包标签页已关闭（page 数 ${pagesBefore.length} → ${pagesAfter.length}）`,
    pagesAfter.map((t) => t.url),
  )

  head('SSE 帧')
  // 方案 A：运行中的连接收到 end 后应保持约 5s 再关。等它自然关闭，
  // 而不是自己 abort，否则测不出"保持"这个行为。
  await Promise.race([stream.done, new Promise((r) => setTimeout(r, 8000))])
  stream.close()
  await stream.done
  const lingerMs = stream.state.endedAt ? stream.state.closedAt - stream.state.endedAt : -1
  const types = stream.frames.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] ?? 0) + 1
    return acc
  }, {})
  info(`收到帧：${JSON.stringify(types)}`)
  expect(stream.frames.some((f) => f.type === 'state'), '有 state 帧')
  expect(stream.frames.some((f) => f.type === 'request'), '有 request 帧')
  expect(stream.frames.some((f) => f.type === 'end'), '有 end 帧')
  expect(lingerMs >= 4000 && lingerMs <= 7500, `end 帧后保持约 5s 再关（${lingerMs}ms）`)

  head('SSE 重连到已结束的会话')
  // 方案 A：运行中收到 end 后保持 5s 再关；但"重连到一个已结束的会话"应当补完
  // state+end 立刻关，不能把前端晾在一个永远没数据的连接上。
  const reconnectStart = Date.now()
  let reconnectText = ''
  try {
    const res = await fetch(`${BASE}/${session.id}/stream`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      reconnectText += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    bad(`重连失败：${err.message}`)
  }
  const reconnectMs = Date.now() - reconnectStart
  expect(reconnectText.includes('"type":"state"'), '重连先补一帧 state')
  expect(reconnectText.includes('"type":"end"'), '重连收到 end 帧')
  expect(reconnectMs < 3000, `重连后立即关闭（${reconnectMs}ms）`)

  head('列表与落盘')
  // 契约里是 GET /local/capture?limit=20（不带尾斜杠）；Hono 对 '/local/capture/' 会 404
  const list = await base('GET', '?limit=20')
  expect(
    list.status === 200 && list.json?.sessions?.some((s) => s.id === session.id),
    '列表包含本次会话',
    { status: list.status, ids: list.json?.sessions?.map((s) => s.id) },
  )
  const file = path.join(root, 'data/capture', `${session.id}.json`)
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    ok(`已落盘 ${path.relative(root, file)}（${saved.requests.length} 条）`)
  } catch (err) {
    bad(`落盘文件缺失：${err.message}`)
  }

  head('apply（block，仅写内存 KV）')
  const applied = await base('POST', '/apply', { hosts: ['ads.selftest.example'], action: 'block' })
  expect(
    applied.status === 200 && applied.json?.added?.includes('ads.selftest.example'),
    'block → added 含目标域名',
    applied.json,
  )
  const again = await base('POST', '/apply', { hosts: ['ads.selftest.example'], action: 'block' })
  expect(
    again.json?.skipped?.some((s) => s.domain === 'ads.selftest.example' && s.reason === '已屏蔽'),
    '重复 block → skipped 已屏蔽',
    again.json,
  )

  console.log('\n  自测摘要：')
  console.log(`    会话       ${session.id}`)
  console.log(`    请求总数   ${requestCount}`)
  console.log(`    域名数     ${summary.json?.hosts?.length ?? '-'}`)
  console.log(`    等待时长   ${WAIT_MS}ms`)
  console.log(`    总耗时     ${elapsed}ms（start → stop）`)

  // 收尾：把自己模拟出来的那个标签页关掉，反复跑不会在 noVNC 里堆页签
  if (userTab) await fetch(`${CDP_URL}/json/close/${userTab.id}`).catch(() => {})
}

// ---------------------------------------------------------------- 入口

async function main() {
  if (LAUNCH) await launchChrome()

  const bundle = await buildRoutes()
  const mod = await import(pathToFileURL(bundle).href)
  // 同一个内存 KV 要跨请求复用：apply 的"已屏蔽"判定依赖上一次写入的结果
  const kv = memoryKV()
  const app = new mod.Hono()
  app.route('/local/capture', mod.createCaptureRoutes(() => ({ custom_hosts: kv }), () => CDP_URL))

  const { serve } = await import('@hono/node-server')
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 200))
  info(`自测服务已起：${BASE}`)

  try {
    if (ONLY_ERRORS) await runErrors(api)
    else await runFlow(api)
  } finally {
    server.close()
    if (!KEEP) await fs.unlink(bundle).catch(() => {})
    if (chromeProc) {
      chromeProc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      chromeProc.kill('SIGKILL')
    }
  }

  console.log(failures === 0 ? '\n\x1b[32m自测通过\x1b[0m' : `\n\x1b[31m自测失败：${failures} 项\x1b[0m`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m自测异常\x1b[0m', err)
  process.exit(1)
})
