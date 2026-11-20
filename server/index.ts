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
  const startedAt = Date.now()

  console.log(`[local/refresh] probing ${domains.length} domains...`)

  // 本地的关键优势：没有 subrequest 限制，可以高并发跑完整探测。
  // 并发 16 是实测出来的平衡点，再高会被系统文件句柄或远处 DNS 限流拖慢。
  const CONCURRENCY = Number(c.req.query("concurrency") || 16)
  const results = []
  let index = 0
  let done = 0

  const workers = Array.from({ length: Math.min(CONCURRENCY, domains.length) }, async () => {
    while (true) {
      const i = index++
      if (i >= domains.length) return
      const r = await probeDomain(domains[i])
      results.push(r)
      done++
      if (done % 20 === 0) {
        console.log(`[local/refresh] ${done}/${domains.length}`)
      }
    }
  })
  await Promise.all(workers)

  // 写入 KV，结构与 Cloudflare 版保持一致，接口输出可直接复用
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

  return c.json({
    ok: true,
    elapsedSeconds: Number(elapsed),
    probed: results.length,
    stored: results.filter((r) => r.bestIp).length,
    withLatency,
    inconsistent: results.filter((r) => r.inconsistent).map((r) => r.domain),
  })
})

root.get("/local/probe", async (c) => {
  const domain = c.req.query("domain")
  if (!domain) return c.json({ error: "domain required" }, 400)
  const r = await probeDomain(domain)
  return c.json(r)
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
