/**
 * 抓包接口的 Mock 服务，供前端（D）与聚合逻辑（C）脱网开发。
 *
 * 严格按 docs/orchestration/contracts/api-capture.md 的形状返回，
 * 包括 SSE 增量、超时请求、缓存请求、第一方/第三方混合的场景。
 *
 * 用法：node scripts/mock-capture.mjs --port 8899
 *      前端把 API 常量指到 http://127.0.0.1:8899 即可（或在控制台临时覆盖 window.__MOCK__）
 */
import http from 'node:http'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const PORT = Number(arg('port', 8899))

const now = () => new Date().toISOString()
const sessions = new Map()
const clients = new Map() // sessionId -> Set<res>

const SAMPLE = [
  // host, kind, ttfb, total, failed, cached, bytes
  ['example.com', 'document', 220, 640, false, false, 24_000],
  ['example.com', 'script', 180, 520, false, false, 88_000],
  ['example.com', 'img', 95, 210, false, false, 41_000],
  ['cdn.example-assets.net', 'script', 6100, 9800, false, false, 210_000],
  ['cdn.example-assets.net', 'font', 5400, 5600, false, false, 44_000],
  ['ads.adnetwork.example', 'script', 8300, 12_400, false, false, 61_000],
  ['ads.adnetwork.example', 'xhr', null, null, true, false, 0],
  ['tracker.example-analytics.io', 'xhr', null, null, true, false, 0],
  ['img.example-cdn.top', 'img', 120, 300, true, true, 0],
  ['static.example.com', 'css', 150, 260, false, false, 12_000],
]

function makeRequests(sessionId) {
  return SAMPLE.map(([host, kind, ttfb, total, failed, cached, bytes], i) => ({
    requestId: `${sessionId}-r${i}`,
    host,
    kind: kind === 'css' ? 'other' : kind,
    ttfbMs: ttfb ?? undefined,
    totalMs: total ?? undefined,
    failed: failed || undefined,
    cached: cached || undefined,
    bytes: bytes || undefined,
    errorText: failed ? 'net::ERR_TIMED_OUT' : undefined,
  }))
}

function summarize(reqs) {
  const byHost = new Map()
  for (const r of reqs) {
    if (!byHost.has(r.host)) byHost.set(r.host, [])
    byHost.get(r.host).push(r)
  }
  const pct = (arr, p) => {
    if (!arr.length) return undefined
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]
  }
  return [...byHost.entries()].map(([host, list]) => {
    const ttfb = list.filter((r) => !r.cached && r.ttfbMs != null).map((r) => r.ttfbMs)
    const total = list.filter((r) => !r.cached && r.totalMs != null).map((r) => r.totalMs)
    const failures = list.filter((r) => r.failed).length
    const slow = (pct(total, 95) ?? 0) > 5000 || (pct(ttfb, 95) ?? 0) > 5000
    const thirdParty = !host.endsWith('example.com')
    const verdict = failures && thirdParty ? 'block' : slow && thirdParty ? 'accel' : slow ? 'ignore' : 'unknown'
    return {
      host,
      requests: list.length,
      failures,
      p50TtfbMs: pct(ttfb, 50),
      p95TtfbMs: pct(ttfb, 95),
      p95TotalMs: pct(total, 95),
      bytes: list.reduce((a, r) => a + (r.bytes || 0), 0),
      thirdParty,
      kinds: [...new Set(list.map((r) => r.kind))],
      verdict,
      reason: failures
        ? `第三方请求失败 ${failures} 次（超时）`
        : slow
          ? `p95 ${Math.round((pct(total, 95) ?? 0) / 100) / 10}s，超过 5s 阈值`
          : '未命中慢请求规则',
      suggested: thirdParty && (slow || failures > 0),
    }
  })
}

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(s)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST',
    })
    return res.end()
  }

  if (p === '/local/capture/env') {
    return json(res, 200, { cdp: true, version: '121.0.6167.85', chromium: 'mock' })
  }

  if (p === '/local/capture/start' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const id = `capture-${Date.now()}-mock`
      const s = {
        id,
        url: JSON.parse(body || '{}').url || 'https://example.com',
        status: 'running',
        startedAt: now(),
        requestCount: 0,
        hostCount: 0,
      }
      const rec = { session: s, requests: [] }
      sessions.set(id, rec)
      clients.set(id, new Set())
      json(res, 200, { session: s })

      // 模拟逐步到达：每隔 250ms 推一个请求
      const reqs = makeRequests(id)
      let i = 0
      const timer = setInterval(() => {
        if (i >= reqs.length) {
          clearInterval(timer)
          s.status = 'stopped'
          s.endedAt = now()
          for (const c of clients.get(id) || []) c.write(`data: ${JSON.stringify({ type: 'end', sessionId: id })}\n\n`)
          return
        }
        const r = reqs[i++]
        // 请求明细挂在 rec 上（session 对象只存计数），写错成 s.requests 会直接抛错
        rec.requests.push(r)
        s.requestCount = rec.requests.length
        s.hostCount = new Set(rec.requests.map((x) => x.host)).size
        for (const c of clients.get(id) || []) {
          c.write(`data: ${JSON.stringify({ type: 'request', request: r })}\n\n`)
        }
      }, 250)
    })
    return
  }

  if (p === '/local/capture') {
    return json(res, 200, { sessions: [...sessions.values()].map((v) => v.session).reverse() })
  }

  const m = p.match(/^\/local\/capture\/([^/]+)(\/summary|\/stop|\/stream)?$/)
  if (m) {
    const [, id, sub] = m
    const rec = sessions.get(id)
    if (!rec) return json(res, 404, { error: 'session not found' })
    if (!sub) return json(res, 200, { session: rec.session, requests: rec.requests })
    if (sub === '/summary') return json(res, 200, { sessionId: id, hosts: summarize(rec.requests) })
    if (sub === '/stop') {
      rec.session.status = 'stopped'
      rec.session.endedAt = now()
      return json(res, 200, { session: rec.session })
    }
    if (sub === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      res.write(`data: ${JSON.stringify({ type: 'state', session: rec.session })}\n\n`)
      clients.get(id).add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clearInterval(ping)
        clients.get(id)?.delete(res)
      })
      return
    }
  }

  if (p === '/local/capture/apply' && req.method === 'POST') {
    return json(res, 200, { added: [], skipped: [], failed: [] })
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`mock capture 已启动: http://127.0.0.1:${PORT}`)
})
