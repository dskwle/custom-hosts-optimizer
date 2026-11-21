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
import {
  probeDomain,
  checkSniBlock,
  getBreakerStatus,
  resetBreakers,
  INTL_DOH_ENABLED,
  IPV6_ENABLED,
} from "./probe.js"
import { resolveAndMeasure } from "./timing.js"
import { taskManager, monitor, type TaskItemResult } from "./tasks.js"
import { cacheStats, clearCache } from "./ipcache.js"
import { checkNetworkChange } from "./netcheck.js"
import { refreshAdsRules, getAdsEnabled, setAdsEnabled, getAdsRules } from "../src/services/ads.js"
import {
  filterBlocked,
  markBlocked,
  listBlocked,
  unmarkBlocked,
  clearBlocked,
} from "./blocked.js"
// src/index.ts 的默认导出是 { fetch } 对象，不是 Hono 实例，
// 因此不能 route() 挂载，只能直接调用它的 fetch。
import worker from "../src/index.js"
import { ALL_DOMAINS, SITE_GROUPS, resolveGroupDomains } from "../src/constants.js"
import { addCustomDomain, removeCustomDomain, getCustomDomains } from "../src/services/hosts.js"
import {
  getBlocklist,
  getBuiltinBlocklist,
  getUserBlocklist,
  addBlocked,
  removeBlocked,
  clearBlocklist,
} from "../src/services/blocklist.js"

const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || "127.0.0.1"

const kv = new FileKV()

// 静态资源目录：控制台页面直接从这里读取
const PUBLIC_DIR = path.resolve(process.cwd(), "public")

// 业务代码只依赖 custom_hosts：本地用文件系统实现，其余配置项
// 都是 Workers 时代遗留（部署地址、内部 token、管理账号），已全部移除。
const env = {
  custom_hosts: kv,
}

// 外层路由：先处理本地专有接口，其余原样转交给 Workers 应用
const root = new Hono()

root.post("/local/refresh", async (c) => {
  const groupParam = c.req.query("group")
  // 默认并发 8：实测 16 时部分 IP 会因连接数压力瞬时失败（伪阴性），
  // 8 在速度与稳定性之间更平衡。
  const CONCURRENCY = Number(c.req.query("concurrency") || 8)
  // wait=true 时同步等待结果（便于脚本调用），否则立刻返回 taskId 供轮询
  const wait = c.req.query("wait") === "true"
  // includeBlocked=true 时连已被判定为 SNI 阻断的域名一起重测，用于复核
  const includeBlocked = c.req.query("includeBlocked") === "true"
  // noCache=true 强制全部重测，用于验证缓存是否失效
  let noCache = c.req.query("noCache") === "true"

  // 刷新前检测网络环境：出口 IP 变了说明换了网络（换 WiFi / 热点 / VPN），
  // 此时上一轮测得的延迟全部不可信，直接清空缓存。
  // 放在刷新入口而不是后台轮询，避免绝大多数时间空转。
  const netCheck = await checkNetworkChange()
  if (netCheck.changed && !noCache) {
    console.log(`[netcheck] ${netCheck.note}，清空 IP 缓存`)
    await clearCache()
    noCache = true
  }

  // 广告规则：每轮批量刷新抓取一次，供 /hosts 拼接。
  // 与域名探测并行执行，不占用主流程时间；失败时保留上一份规则。
  const adsEnabled = await getAdsEnabled(env as any)
  const adsPromise = adsEnabled
    ? refreshAdsRules(env as any).catch((e) => ({ ok: false, error: String(e) }))
    : Promise.resolve({ ok: true as const, skipped: true })

  const requested = resolveGroupDomains(groupParam)

  // 默认跳过已知 SNI 阻断的域名：这些域名改 hosts 无效，
  // 每轮重测只会白等 TLS 超时。需要复核时传 includeBlocked=true。
  const { allowed: filtered, skipped } = includeBlocked
    ? { allowed: requested, skipped: [] as string[] }
    : await filterBlocked(requested)

  if (skipped.length > 0) {
    console.log(
      `[local/refresh] 跳过 ${skipped.length} 个已知 SNI 阻断域名: ${skipped.join(", ")}`
    )
  }

  // 被用户屏蔽的域名不参与优选：测出来也不会写进 hosts，纯粹浪费一轮探测
  const blocklist = await getBlocklist(env as any)
  const blockedNames = new Set(blocklist.map((b) => b.domain))
  const domains = blockedNames.size
    ? filtered.filter((d) => !blockedNames.has(d.toLowerCase()))
    : filtered

  if (domains.length < filtered.length) {
    console.log(`[local/refresh] 跳过 ${filtered.length - domains.length} 个已屏蔽域名`)
  }

  const task = taskManager.create("refresh", domains.length)

  const run = async () => {
    const startedAt = Date.now()
    console.log(`[local/refresh] ${task.taskId} probing ${domains.length} domains`)

    const results: TaskItemResult[] = []
    // 只有「两次判定都阻断」的域名才计入，避免把并发引起的偶发超时算成新发现
    const confirmedBlocked: string[] = []
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
            // 批量也做 SNI 检测：前端点开某个域名时要能看到与单次检测一致的完整信息
            const r = await probeDomain(domain, { checkSni: true, useCache: !noCache })

            // 判定为 SNI 阻断的域名记入排除清单，后续刷新默认跳过。
            // 判定依据是 checkSniBlock 的双 SNI 对照，可靠性较高：
            // 真实域名握手失败、换无关 SNI 却成功，说明阻断由域名匹配触发。
            // 批量并发跑的时候，TLS 握手偶尔会因为本机连接数压力超时，
            // 单次判定容易把正常域名误判成 SNI 阻断（实测一整轮全量刷新后
            // 32 条阻断里有 23 条是误判）。这里再单独复核一次，
            // 两次都判定阻断才写进清单——代价只在少数可疑域名上多花一次握手。
            if (r.sni?.verdict === "sni-blocked") {
              const confirm = await probeDomain(domain, { checkSni: true, useCache: false })
              if (confirm.sni?.verdict === "sni-blocked") {
                confirmedBlocked.push(domain)
                await markBlocked(domain, {
                  reason: r.sni.explanation,
                  withSniError: r.sni.withSni.error,
                  withoutSniMs: r.sni.withoutSni.ms,
                })
              } else {
                console.log(`[local/refresh] ${domain} 首轮判为 SNI 阻断，复核后为 ${confirm.sni?.verdict}，不计入`)
              }
            }

            // 失败原因：优先取 SNI 结论，否则汇总 TLS 失败原因
            let error: string | undefined
            if (!r.bestIp) {
              if (r.sni) {
                error = r.sni.explanation
              } else if (r.uniqueIpCount > 0) {
                const reasons = [
                  ...new Set(
                    r.candidates.map((x) => x.tlsError).filter(Boolean)
                  ),
                ]
                error = `${r.uniqueIpCount} 个 IP 均无法完成 TLS 握手（${reasons.join(" / ") || "未知"}）`
              } else {
                error = "所有 DNS 源均未返回 A 记录"
              }
            }

            const item: TaskItemResult = {
              domain,
              ok: r.bestIp !== null,
              bestIp: r.bestIp,
              family: r.bestIp ? (r.candidates.find((x) => x.ip === r.bestIp)?.family ?? "v4") : undefined,
              latency: r.latency,
              tlsOk: r.tlsOkCount > 0,
              candidateCount: r.uniqueIpCount,
              tlsOkCount: r.tlsOkCount,
              cacheHits: r.cacheHits,
              tlsMs: r.tlsMs,
              error,
              detail: {
                providers: r.providers,
                candidates: r.candidates,
                systemIps: r.systemIps,
                upstreamIps: r.upstreamIps,
                hostsOverride: r.hostsOverride,
                inconsistent: r.inconsistent,
                systemDiffers: r.systemDiffers,
                totalResolvedEntries: r.totalResolvedEntries,
                v4Count: r.v4Count,
                v6Count: r.v6Count,
                sni: r.sni,
              },
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
              error: `探测过程异常：${(err as Error).message}`,
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
      // bestIp 为空说明没有任何 IP 能完成 TLS 握手。
      // 这种情况要把已有记录标记为不可用，而不是留着旧的好地址——
      // 旧地址可能早已失效（比如 golang 那批），继续输出会误导。
      if (!r.bestIp) {
        const prev = existing.domain_data[r.domain]
        if (prev) {
          existing.domain_data[r.domain] = {
            ...prev,
            lastChecked: now,
            isOptimized: false,
          }
        }
        continue
      }

      existing.domain_data[r.domain] = {
        ip: r.bestIp,
        lastUpdated: now,
        lastChecked: now,
        responseTime: r.latency ?? undefined,
        provider: "local-multi-doh",
        // 只有 TLS 握手成功才会走到这里，因此恒为 true
        isOptimized: true,
        resolvedAt: now,
      }
    }
    existing.lastUpdated = now
    existing.updateCount = (existing.updateCount || 0) + 1
    await kv.put("domain_data", JSON.stringify(existing))

    const withLatency = results.filter((r) => r.latency !== null).length
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[local/refresh] done in ${elapsed}s, ${withLatency}/${results.length} with latency`)

    const blockedNow = confirmedBlocked.length
    const adsResult = await adsPromise

    taskManager.complete(
      task.taskId,
      `${withLatency}/${results.length} 有延迟，耗时 ${elapsed}s` +
        (skipped.length ? `，跳过 ${skipped.length} 个 SNI 阻断` : "") +
        (blockedNow ? `，新发现 ${blockedNow} 个 SNI 阻断` : "")
    )

    return {
      ok: true,
      elapsedSeconds: Number(elapsed),
      probed: results.length,
      stored: results.filter((r) => r.bestIp).length,
      withLatency,
      skippedBlocked: skipped,
      newBlocked: blockedNow,
      ads: adsResult,
    }
  }

  if (wait) {
    const summary = await run()
    return c.json({ taskId: task.taskId, network: netCheck, ...summary })
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
    skippedBlocked: skipped,
    network: netCheck,
    poll: `/local/tasks/${task.taskId}`,
  })
})

/* ---------- SNI 阻断域名排除清单 ---------- */

root.get("/local/blocked", async (c) => {
  const entries = await listBlocked()
  return c.json({ count: entries.length, entries })
})

// 解除单个域名的排除，下次刷新会重新检测
root.delete("/local/blocked/:domain", async (c) => {
  const domain = decodeURIComponent(c.req.param("domain"))
  const removed = await unmarkBlocked(domain)
  return c.json({ ok: removed, domain })
})

root.post("/local/blocked/clear", async (c) => {
  const n = await clearBlocked()
  return c.json({ ok: true, cleared: n })
})

/** 对一个已知阻断的域名重新检测，确认是否恢复 */
root.post("/local/blocked/recheck", async (c) => {
  const entries = await listBlocked()
  const results = []
  for (const e of entries) {
    const r = await probeDomain(e.domain, { checkSni: true })
    const recovered = r.bestIp !== null
    if (recovered) {
      await unmarkBlocked(e.domain)
    }
    results.push({
      domain: e.domain,
      recovered,
      verdict: r.sni?.verdict ?? null,
    })
  }
  return c.json({
    checked: results.length,
    recovered: results.filter((x) => x.recovered).length,
    results,
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
  // 默认做 SNI 检测：这是判断「改了 hosts 到底有没有用」的关键依据
  const checkSni = c.req.query("sni") !== "false"
  const r = await probeDomain(domain, { checkSni })
  return c.json(r)
})

/**
 * 把「检测通过」的域名连同实测最优 IP 一起写成自定义域名。
 *
 * 与 /api/custom-domains/batch 的区别：那个接口会自己再解析一次 IP，
 * 可能把刚测好的最优地址换成另一个（甚至换成不可用的那个）；
 * 这里直接落库探测结果，包含 IPv6 地址，hosts 输出与检测结论一致。
 */
root.post("/local/adopt", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { items?: Array<{ domain?: string; ip?: string }> }
    | null
  const items = (body?.items ?? []).filter(
    (x): x is { domain: string; ip?: string } => !!x && typeof x.domain === "string" && !!x.domain.trim()
  )
  if (!items.length) return c.json({ ok: false, error: "items 为空" }, 400)

  const added: string[] = []
  const updated: string[] = []
  const skipped: Array<{ domain: string; reason: string }> = []
  const failed: Array<{ domain: string; error: string }> = []

  // 已在内置加速清单、或已经加过自定义域名的，不再重复写入，交给前端提示
  const builtinSet = new Set(ALL_DOMAINS.map((d: string) => d.toLowerCase()))
  const customSet = new Set((await getCustomDomains(env as any)).map((d) => d.domain.toLowerCase()))
  // 已被屏蔽的域名加进自定义也没有意义：hosts 里会被屏蔽区覆盖
  const blockedSet = new Set((await getBlocklist(env as any)).map((b) => b.domain.toLowerCase()))

  for (const it of items) {
    const domain = it.domain.trim().toLowerCase()
    const ip = typeof it.ip === "string" ? it.ip.trim() : undefined
    if (builtinSet.has(domain)) {
      skipped.push({ domain, reason: "内置加速" })
      continue
    }
    if (customSet.has(domain)) {
      skipped.push({ domain, reason: "已在自定义域名" })
      continue
    }
    if (blockedSet.has(domain)) {
      skipped.push({ domain, reason: "已屏蔽" })
      continue
    }
    try {
      const r = await addCustomDomain(env as any, domain, ip || undefined)
      if (!r) failed.push({ domain, error: "解析或写入失败" })
      else if (r.isUpdate) updated.push(domain)
      else added.push(domain)
      customSet.add(domain)
    } catch (e) {
      failed.push({ domain, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return c.json({ ok: true, added, updated, skipped, failed })
})

/** 自定义屏蔽清单：hosts 里同时写 0.0.0.0 与 :: 两条，IPv4/IPv6 都堵死 */
root.get("/local/blocklist", async (c) => {
  // 内置项不在「屏蔽网站」列表里展示（避免误以为可删），只返回数量
  const entries = await getUserBlocklist(env as any)
  const builtin = getBuiltinBlocklist()
  return c.json({ count: entries.length, entries, builtinCount: builtin.length, builtin })
})

root.post("/local/blocklist", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { domains?: string[] | string; text?: string }
    | null
  let inputs: string[] = []
  if (Array.isArray(body?.domains)) inputs = body!.domains.map(String)
  else if (typeof body?.domains === "string") inputs = body!.domains.split(/\r?\n/)
  else if (typeof body?.text === "string") inputs = body!.text.split(/\r?\n/)

  if (!inputs.length) return c.json({ ok: false, error: "domains 为空" }, 400)

  const r = await addBlocked(env as any, inputs)

  // 同一域名如果还在自定义域名里，先摘掉：hosts 只留屏蔽区那一条，
  // 否则表里会出现「指向优选 IP」和「指向 0.0.0.0」两种互相矛盾的记录。
  for (const d of r.added) {
    try {
      await removeCustomDomain(env as any, d)
    } catch {
      /* 不存在就忽略 */
    }
  }

  return c.json({ ok: true, ...r })
})

root.delete("/local/blocklist/:domain", async (c) => {
  const r = await removeBlocked(env as any, c.req.param("domain"))
  return c.json(r, r.ok ? 200 : 400)
})

/**
 * 域名规则查询：模糊匹配某个域名落在哪条规则里。
 * 四个来源：内置加速、内置屏蔽、手动加速（自定义域名）、手动屏蔽。
 * 不传 q 时返回全部（用于按分类浏览），最多返回 300 条。
 */
root.get("/local/lookup", async (c) => {
  const raw = (c.req.query("q") || "").trim().toLowerCase()
  const mode = (c.req.query("mode") || "contains").toLowerCase()
  const cats = new Set(
    (c.req.query("cats") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const want = (cat: string) => cats.size === 0 || cats.has(cat)

  type Row = {
    domain: string
    category: string
    label: string
    detail?: string
    addedAt?: string
  }
  const rows: Row[] = []

  if (want("builtin-accel")) {
    for (const g of SITE_GROUPS) {
      for (const d of g.domains) {
        rows.push({ domain: d, category: "builtin-accel", label: "内置加速", detail: g.name })
      }
    }
  }
  if (want("builtin-block")) {
    for (const d of getBuiltinBlocklist()) {
      rows.push({ domain: d, category: "builtin-block", label: "内置屏蔽" })
    }
  }
  if (want("custom-accel")) {
    for (const x of await getCustomDomains(env as any)) {
      rows.push({
        domain: x.domain,
        category: "custom-accel",
        label: "手动加速",
        detail: x.ip ? `指向 ${x.ip}` : undefined,
        addedAt: x.addedAt,
      })
    }
  }
  if (want("custom-block")) {
    for (const x of await getUserBlocklist(env as any)) {
      rows.push({ domain: x.domain, category: "custom-block", label: "手动屏蔽", addedAt: x.addedAt })
    }
  }

  // 三种匹配方式：包含（子串）、正则（JS 片段）、占位符（* 任意串 / ? 单字符）
  let match: (d: string) => boolean
  if (mode === "regex") {
    let re: RegExp
    try {
      re = new RegExp(raw, "i")
    } catch (e) {
      return c.json({ ok: false, error: "正则语法错误：" + (e instanceof Error ? e.message : String(e)) }, 400)
    }
    match = (d) => re.test(d)
  } else if (mode === "glob") {
    // 没写通配符时按「包含」处理，避免 `github` 一条都匹配不到
    const pattern = /[*?]/.test(raw) ? raw : `*${raw}*`
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    const re = new RegExp(`^${escaped}$`, "i")
    match = (d) => re.test(d)
  } else {
    match = (d) => d.includes(raw)
  }

  const totalAll = rows.length
  const matched = raw ? rows.filter((r) => match(r.domain)) : rows
  // 精确命中排最前，其次前缀命中，其余按域名长度（越短越可能是主域）
  const rank = (d: string) => (d === raw ? 0 : d.startsWith(raw) ? 1 : 2)
  matched.sort((a, b) => rank(a.domain) - rank(b.domain) || a.domain.length - b.domain.length || a.domain.localeCompare(b.domain))

  return c.json({
    ok: true,
    query: raw,
    mode,
    total: matched.length,
    totalAll,
    truncated: matched.length > 300,
    results: matched.slice(0, 300),
  })
})

root.post("/local/blocklist/clear", async (c) => {
  const cleared = await clearBlocklist(env as any)
  return c.json({ ok: true, cleared })
})

/** 仅做 SNI 阻断检测，用于快速判断某域名属于哪类问题 */
root.get("/local/sni", async (c) => {
  const domain = c.req.query("domain")
  if (!domain) return c.json({ error: "domain required" }, 400)
  const ip = c.req.query("ip") || undefined

  let targetIp = ip
  if (!targetIp) {
    const probe = await probeDomain(domain)
    targetIp = probe.bestIp ?? undefined
  }
  if (!targetIp) {
    return c.json({ domain, error: "无法解析出可用 IP" }, 400)
  }

  const r = await checkSniBlock(domain, targetIp)
  return c.json({ domain, ip: targetIp, ...r })
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

  // probeDomain 内部已用 Set 对所有 DNS 源去重，
  // 每个唯一 IP 只做一次 TCP + TLS 检测，结果通过 candidates 返回。
  const probe = await probeDomain(domain, { checkSni: true })

  // 只对 TLS 握手成功的候选做多轮完整计时：
  // TLS 都握不上的 IP 本来就不能用，测它的 TTFB 没有意义。
  const candidates = probe.candidates
    .filter((x) => x.tlsOk && x.latency !== null)
    .slice(0, 5)

  const details = await Promise.all(
    candidates.map(async (cand) => {
      const samples: Awaited<ReturnType<typeof resolveAndMeasure>>[] = []
      for (let i = 0; i < rounds; i++) {
        // skipDns：IP 已确定，不必再解析一次
        samples.push(await resolveAndMeasure(domain, cand.ip, { skipDns: true }))
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
        tlsMs: cand.tlsMs,
        tlsOk: cand.tlsOk,
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
    candidateCount: probe.uniqueIpCount,
    /** TLS 握手成功的候选数 —— 只有这些能用于 hosts */
    tlsOkCount: probe.tlsOkCount,
    /** 全部候选的检测明细，含 TLS 失败项，便于说明为何被排除 */
    allCandidates: probe.candidates,
    // 去重前各 DNS 源返回的条目数之和，与 candidateCount 对比即可看出重叠程度
    totalResolvedEntries: probe.totalResolvedEntries,
    dedupSaved: Math.max(probe.totalResolvedEntries - probe.uniqueIpCount, 0),
    systemIps: probe.systemIps,
    systemIps6: probe.systemIps6,
    v4Count: probe.v4Count,
    v6Count: probe.v6Count,
    upstreamIps: probe.upstreamIps,
    hostsOverride: probe.hostsOverride,
    inconsistent: probe.inconsistent,
    systemDiffers: probe.systemDiffers,
    providers: probe.providers,
    sni: probe.sni,
    recommended: details[0]?.ip ?? null,
    details,
  })
})

/** 长时间监控：启动后按间隔反复采样，结果进入时序，可查趋势 */
root.post("/local/monitor/start", async (c) => {
  const intervalSec = Number(c.req.query("interval") || 300)
  const groupParam = c.req.query("group")
  const requested = resolveGroupDomains(groupParam)

  // 监控同样跳过 SNI 阻断的域名：它们每轮都会失败，
  // 反复采样只会污染趋势图，也会拖慢整轮。
  const { allowed: domains, skipped } = await filterBlocked(requested)

  monitor.configure({
    domainSource: () => domains,
    sampler: async (domain) => {
      const r = await probeDomain(domain)
      return {
        domain,
        ok: r.bestIp !== null,   // bestIp 非空 == TLS 握手成功，才可写进 hosts
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
    skippedBlocked: skipped,
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

/** 各 DoH 服务商的可达性/熔断状态，便于排查问题 */
root.get("/local/doh", async (c) => {
  const status = getBreakerStatus()

  // 只对当前启用的源做实时探测，避免为了展示而白等国际源超时
  const probes = await Promise.all(
    [
      { name: "AliDNS", url: "https://dns.alidns.com/resolve?name=example.com&type=A" },
      { name: "DNSPod", url: "https://doh.pub/dns-query?name=example.com&type=A" },
      { name: "Cloudflare", url: "https://1.1.1.1/dns-query?name=example.com&type=A" },
      { name: "Google", url: "https://dns.google/resolve?name=example.com&type=A" },
    ]
      .filter((p) => status.find((s) => s.name === p.name)?.enabled)
      .map(async (p) => {
        const t0 = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        try {
          const res = await fetch(p.url, {
            headers: { accept: "application/dns-json" },
            signal: controller.signal,
          })
          return { name: p.name, reachable: res.ok, ms: Date.now() - t0 }
        } catch {
          return { name: p.name, reachable: false, ms: null }
        } finally {
          clearTimeout(timer)
        }
      })
  )

  // 未启用的源单独说明，避免用户以为「少了两家」
  const disabled = status
    .filter((s) => !s.enabled)
    .map((s) => ({
      name: s.name,
      reason: "国际 DoH，当前网络不可达，已默认关闭；设置 ENABLE_INTL_DOH=true 可启用",
    }))

  return c.json({
    breakers: status,
    live: probes,
    disabledIntl: disabled,
    intlEnabled: INTL_DOH_ENABLED,
    ipv6Enabled: IPV6_ENABLED,
  })
})

root.post("/local/doh/reset", (c) => {
  resetBreakers()
  return c.json({ ok: true })
})

/** 广告规则状态：开关、条目数、抓取时间 */
root.get("/local/ads", async (c) => {
  const enabled = await getAdsEnabled(env as any)
  const meta = await getAdsRules(env as any)
  return c.json({
    enabled,
    ruleCount: meta?.ruleCount ?? 0,
    fetchedAt: meta?.fetchedAt ?? null,
    version: meta?.version ?? null,
    upstreamUpdatedAt: meta?.upstreamUpdatedAt ?? null,
    source: "AWAvenue-Ads-Rule",
  })
})

/** 切换开关；开启时若还没有规则则立即抓一次 */
root.post("/local/ads", async (c) => {
  let enabled: boolean | null = null
  try {
    const body = await c.req.json()
    if (typeof body?.enabled === "boolean") enabled = body.enabled
  } catch {
    // 也接受 query 形式，便于 curl 调用
  }
  const q = c.req.query("enabled")
  if (enabled === null && q != null) enabled = q !== "false"
  if (enabled === null) return c.json({ error: "enabled 参数必填" }, 400)

  const saved = await setAdsEnabled(env as any, enabled)
  let fetched = null
  if (enabled) {
    const existing = await getAdsRules(env as any)
    // 首次开启或规则缺失时补抓一次，避免用户还要手动刷一轮
    if (!existing) fetched = await refreshAdsRules(env as any)
  }
  return c.json({ ok: saved, enabled, fetched })
})

/** 立即重新抓取规则（不影响开关） */
root.post("/local/ads/refresh", async (c) => {
  const r = await refreshAdsRules(env as any)
  return c.json(r)
})

/** IP 延迟缓存状态：命中情况与条目数 */
root.get("/local/cache", async (c) => {
  const stats = await cacheStats()
  return c.json({
    ...stats,
    ttlMinutes: Math.round(stats.ttlMs / 60000),
  })
})

/** 当前网络身份：出口 IP 与上次记录，用于排查缓存为何被清 */
root.get("/local/network", async (c) => {
  const r = await checkNetworkChange()
  return c.json(r)
})

root.post("/local/cache/clear", async (c) => {
  const n = await clearCache()
  return c.json({ ok: true, cleared: n })
})

// 本地增强功能页面（真实延迟、进度、监控），仅本分支提供
root.get("/local", async (c) => {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "console.html"), "utf8")
    return c.html(html)
  } catch {
    return c.text("console.html not found", 404)
  }
})

// 本地版首页直接是控制台：把 hosts 内容与全部诊断功能放在一页，
// 不做权限控制，也不区分管理路径。
root.get("/", async (c) => {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "console.html"), "utf8")
    return c.html(html)
  } catch {
    return c.text("console.html not found", 404)
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

// 兜底：/local/* 之外的请求交给原应用（hosts / hosts.json / api）。
// 认证中间件已随管理后台一并移除，本地不再需要补凭据。
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
