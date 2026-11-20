/**
 * 本地运行时入口。
 *
 * 复用 src/index.ts 里已有的 Hono 应用（路由、业务逻辑都不改动），
 * 通过注入 Node 版 KV 让它在 Node 里跑起来；另外挂载几个仅本地可用的接口。
 *
 * 为什么要有这个分支：Cloudflare Workers 有两条硬限制，
 * 一是每请求 50 个 subrequest，二是 cron 执行时长受限，
 * 导致 137 个域名跑一轮刷新要拆成 18 个分片、还经常跑不完。
 * 本地跑没有这些限制，可以一次刷新全部域名并做完整 IP 优选。
 */
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { FileKV } from "./kv.js"
import { probeDomain } from "./probe.js"
import { resolveAndMeasure, measureTiming, measureTcpOnly } from "./timing.js"
import { taskManager, monitor, type TaskItemResult } from "./tasks.js"
// src/index.ts 的默认导出是 { fetch, scheduled } 对象（Workers 入口约定），
// 不是 Hono 实例，因此不能 route() 挂载，只能直接调用它的 fetch。
import worker from "../src/index.js"
import { ALL_DOMAINS, SITE_GROUPS, resolveGroupDomains } from "../src/constants.js"

const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || "127.0.0.1"

const kv = new FileKV()

// 静态资源：把 public/ 读进内存，模拟 ASSETS.fetch 的行为
const PUBLIC_DIR = path.resolve(process.cwd(), "public")

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
    }[ext] || "application/octet-stream"
  )
}

const assetsBinding = {
  async fetch(input: any): Promise<Response> {
    // 兼容两种调用：传 Request 对象（原应用写法），或传 URL/字符串
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input?.url
    if (!urlStr) {
      return new Response("bad request", { status: 400 })
    }
    const url = new URL(urlStr)
    const rel = url.pathname === "/" ? "/index.html" : url.pathname
    // 防目录穿越
    const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""))
    if (!target.startsWith(PUBLIC_DIR)) {
      return new Response("forbidden", { status: 403 })
    }
    try {
      const buf = await readFile(target)
      return new Response(buf, {
        headers: { "content-type": contentType(target) },
      })
    } catch {
      return new Response("not found", { status: 404 })
    }
  },
}

const env = {
  custom_hosts: kv as any,
  ASSETS: assetsBinding as any,
  WORKER_URL: `http://${HOST}:${PORT}`,
  INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || "local-dev-token",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ENABLE_OPTIMIZATION: process.env.ENABLE_OPTIMIZATION || "true",
  API_KEY: process.env.API_KEY,
}

// 外层路由：先处理本地专有接口，其余原样转交给 Workers 应用
const root = new Hono()

root.post("/local/refresh", async (c) => {
  const groupParam = c.req.query("group")
  const domains = resolveGroupDomains(groupParam)
  const CONCURRENCY = Number(c.req.query("concurrency") || 16)
  // wait=true 时同步等待结果（便于脚本调用），否则立刻返回 taskId 供轮询
  const wait = c.req.query("wait") === "true"

  const task = taskManager.create("refresh", domains.length)

  const run = async () => {
    const startedAt = Date.now()
    console.log(`[local/refresh] ${task.taskId} probing ${domains.length} domains`)

    const results: TaskItemResult[] = []
    let index = 0

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, domains.length) },
      async () => {
        while (true) {
          const i = index++
          if (i >= domains.length) return
          const domain = domains[i]
          taskManager.startItem(task.taskId, domain)
          try {
            const r = await probeDomain(domain)
            const item: TaskItemResult = {
              domain,
              ok: r.latency !== null,
              bestIp: r.bestIp,
              latency: r.latency,
              source: "local",
            }
            results.push(item)
            taskManager.finishItem(task.taskId, item)
          } catch (err) {
            taskManager.finishItem(task.taskId, {
              domain,
              ok: false,
              bestIp: null,
              latency: null,
              source: "local",
            })
          }
        }
      }
    )
    await Promise.all(workers)

    // 写入 KV，结构与 Cloudflare 版保持一致
    const now = new Date().toISOString()
    const existing = ((await kv.get("domain_data", { type: "json" })) as any) || {
      domain_data: {},
      updateCount: 0,
      version: "1.0.0",
    }

    for (const r of results) {
      if (!r.bestIp) continue
      existing.domain_data[r.domain] = {
        ip: r.bestIp,
        lastUpdated: now,
        lastChecked: now,
        responseTime: r.latency ?? undefined,
        provider: "local-multi-doh",
        isOptimized: r.latency !== null,
        resolvedAt: now,
      }
    }
    existing.lastUpdated = now
    existing.updateCount = (existing.updateCount || 0) + 1
    await kv.put("domain_data", JSON.stringify(existing))

    const withLatency = results.filter((r) => r.latency !== null).length
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[local/refresh] done in ${elapsed}s, ${withLatency}/${results.length} with latency`)

    taskManager.complete(
      task.taskId,
      `${withLatency}/${results.length} 有延迟，耗时 ${elapsed}s`
    )

    return {
      ok: true,
      elapsedSeconds: Number(elapsed),
      probed: results.length,
      stored: results.filter((r) => r.bestIp).length,
      withLatency,
    }
  }

  if (wait) {
    const summary = await run()
    return c.json({ taskId: task.taskId, ...summary })
  }

  void run().catch((err) => {
    console.error("[local/refresh] failed", err)
    taskManager.fail(task.taskId, String(err))
  })

  // 立即返回，前端拿 taskId 轮询 /local/tasks/:id
  return c.json({
    ok: true,
    accepted: true,
    taskId: task.taskId,
    total: domains.length,
    poll: `/local/tasks/${task.taskId}`,
  })
})

/** 任务进度查询 */
root.get("/local/tasks", (c) => c.json({ tasks: taskManager.list() }))

root.get("/local/tasks/:id", (c) => {
  const task = taskManager.get(c.req.param("id"))
  if (!task) return c.json({ error: "task not found" }, 404)
  return c.json(task)
})


root.get("/local/probe", async (c) => {
  const domain = c.req.query("domain")
  if (!domain) return c.json({ error: "domain required" }, 400)
  const r = await probeDomain(domain)
  return c.json(r)
})

/**
 * 真实延迟：把 HTTPS 请求拆成 dns / tcp / tls / ttfb 四段分别计时。
 * 不传 ip 时先解析再测；传了 ip 就测该 IP（用于验证某个 hosts 条目实际效果）。
 */
root.get("/local/timing", async (c) => {
  const domain = c.req.query("domain")
  const ip = c.req.query("ip") || undefined
  if (!domain) return c.json({ error: "domain required" }, 400)
  const r = await resolveAndMeasure(domain, ip)
  return c.json(r)
})

/**
 * 候选 IP 全量分层对比：先解析出所有候选，对每个做 TCP 初筛，
 * 再对最快的几个做完整 tls/ttfb 计时。
 * 这是本地版独有的能力——Cloudflare 版受 subrequest 限制做不到。
 */
root.get("/local/compare", async (c) => {
  const domain = c.req.query("domain")
  if (!domain) return c.json({ error: "domain required" }, 400)
  const roundRaw = Number(c.req.query("rounds") || 3)
  const rounds = Math.min(Math.max(roundRaw, 1), 5)

  const probe = await probeDomain(domain)
  const candidates = probe.candidates.filter((x) => x.latency !== null).slice(0, 5)

  const details = await Promise.all(
    candidates.map(async (cand) => {
      const samples: Awaited<ReturnType<typeof resolveAndMeasure>>[] = []
      for (let i = 0; i < rounds; i++) {
        samples.push(await resolveAndMeasure(domain, cand.ip))
      }
      const okSamples = samples.filter((s) => s.ok && s.totalMs !== null)
      const avg = okSamples.length
        ? Math.round(
            okSamples.reduce((a, b) => a + (b.totalMs ?? 0), 0) / okSamples.length
          )
        : null
      const best = okSamples.length
        ? Math.min(...okSamples.map((s) => s.totalMs ?? Infinity))
        : null
      return {
        ip: cand.ip,
        tcpMs: cand.latency,
        avgTotalMs: avg,
        bestTotalMs: best,
        okRate: Math.round((okSamples.length / rounds) * 100),
        last: samples[samples.length - 1],
      }
    })
  )

  details.sort((a, b) => {
    if (a.avgTotalMs === null && b.avgTotalMs === null) return 0
    if (a.avgTotalMs === null) return 1
    if (b.avgTotalMs === null) return -1
    return a.avgTotalMs - b.avgTotalMs
  })

  return c.json({
    domain,
    rounds,
    candidateCount: probe.candidates.length,
    systemIps: probe.systemIps,
    inconsistent: probe.inconsistent,
    recommended: details[0]?.ip ?? null,
    details,
  })
})

/** 长时间监控：启动后按间隔反复采样，结果进入时序，可查趋势 */
root.post("/local/monitor/start", (c) => {
  const intervalSec = Number(c.req.query("interval") || 300)
  const groupParam = c.req.query("group")
  const domains = resolveGroupDomains(groupParam)

  monitor.configure({
    domainSource: () => domains,
    sampler: async (domain) => {
      const r = await probeDomain(domain)
      return {
        domain,
        ok: r.latency !== null,
        bestIp: r.bestIp,
        latency: r.latency,
        source: "probe" as const,
      }
    },
    intervalMs: Math.max(intervalSec, 30) * 1000,
    concurrency: Number(c.req.query("concurrency") || 8),
  })

  const started = monitor.start()
  return c.json({
    ok: true,
    started,
    alreadyRunning: !started,
    domains: domains.length,
    intervalMs: Math.max(intervalSec, 30) * 1000,
  })
})

root.post("/local/monitor/stop", (c) => c.json({ ok: true, stopped: monitor.stop() }))

root.get("/local/monitor/status", (c) => c.json(monitor.status()))

/** 拉取时序数据，前端画趋势折线 */
root.get("/local/series", (c) => {
  const domainParam = c.req.query("domains")
  const limit = Number(c.req.query("limit") || 200)
  const domains = domainParam
    ? domainParam.split(",").map((s) => s.trim()).filter(Boolean)
    : resolveGroupDomains(c.req.query("group")).slice(0, 10)
  return c.json({ series: taskManager.getSeries(domains, limit) })
})

root.post("/local/series/clear", (c) => {
  taskManager.clearSeries()
  return c.json({ ok: true })
})

root.get("/local/groups", (c) =>
  c.json({
    total: ALL_DOMAINS.length,
    groups: SITE_GROUPS.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      count: g.domains.length,
    })),
  })
)

root.get("/local/health", (c) =>
  c.json({ ok: true, runtime: "node", pid: process.pid, port: PORT })
)

// 本地增强功能页面（真实延迟、进度、监控），仅本分支提供
root.get("/local", async (c) => {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "local.html"), "utf8")
    return c.html(html)
  } catch {
    return c.text("local.html not found", 404)
  }
})

// Workers 的 ExecutionContext 在 Node 里没有对应物。
// src/ 只用到了 waitUntil（后台任务），这里用 fire-and-forget 模拟：
// 不阻塞响应，出错只打日志，行为与 waitUntil 足够接近。
const fakeCtx = {
  waitUntil(promise: Promise<unknown>) {
    Promise.resolve(promise).catch((err) => console.error("[waitUntil]", err))
  },
  passThroughOnException() {
    /* Node 环境无此语义，忽略 */
  },
}

// 兜底：所有 /local/* 之外、以及未命中的请求交给原应用处理。
// 用 all("*") 而不是 route("/") ，是因为 worker.fetch 是普通函数而非 Hono 实例。
root.all("*", (c) => worker.fetch(c.req.raw, env as any, fakeCtx as any))

serve({ fetch: (req) => root.fetch(req, env), port: PORT, hostname: HOST }, (info) => {
  console.log(`\n  本地运行时已启动: http://${HOST}:${info.port}`)
  console.log(`  域名总数: ${ALL_DOMAINS.length} / ${SITE_GROUPS.length} 个分组`)
  console.log(`  KV 存储目录: data/kv\n`)
  console.log(`  常用命令:`)
  console.log(`    curl -X POST "http://${HOST}:${info.port}/local/refresh"          刷新全部`)
  console.log(`    curl -X POST "http://${HOST}:${info.port}/local/refresh?group=npm" 只刷新指定组`)
  console.log(`    curl "http://${HOST}:${info.port}/local/probe?domain=api.github.com"  探测单个域名`)
  console.log(`    curl "http://${HOST}:${info.port}/local/groups"                  查看分组\n`)
})
