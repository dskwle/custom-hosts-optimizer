import { Hono } from "hono"
import type { Context } from "hono"
import {
  formatHostsFile,
  formatFastHosts,
  formatBlockHosts,
  getDomainData,
  getCompleteHostsData,
  getHostsData,
  getDataUpdatedAt,
  getV6BrokenDomains,
  getCustomDomains,
  addCustomDomain,
  removeCustomDomain,
  touchCustomChanged,
  customDomainAddrs,
  type HostEntry,
  type CustomDomain,
} from "./services/hosts"
import { SITE_GROUPS, resolveGroupDomains } from "./constants"
import { mergeCustomWithBuiltin } from "./merge"
import { parseAddrInput } from "./services/dualstack"
import { getAdsEnabled, getAdsRules } from "./services/ads"
import { getBlocklist, getBuiltinBlocklist } from "./services/blocklist"
import { getPausedAccel, getPausedShield } from "../server/paused.ts"
import { Bindings } from "./types"

const app = new Hono<{ Bindings: Bindings }>()
type Ctx = Context<{ Bindings: Bindings }>

// 本地版不做权限控制，也不再需要管理后台页面：
// 控制台（public/console.html）已取代原内联管理页。


app.get("/hosts.json", async (c) => {
  try {
    // 检查是否强制刷新缓存
    const forceRefresh = c.req.query('refresh') === 'true'
    // 站点分组过滤：?group=github,npm，不传则输出全部
    const groupParam = c.req.query('group')
    
    console.log(`JSON request - refresh: ${forceRefresh}, group: ${groupParam || 'all'}`)

    // 同 /hosts：KV 为空时直接返回空结构，避免回落到慢速抓取
    const dataAt = await getDataUpdatedAt(c.env)
    if (!dataAt) {
      c.header('Cache-Control', 'no-store')
      return c.json({
        entries: [],
        total: 0,
        groups: [],
        github: [],
        custom: [],
        includeCustom: true,
        timestamp: null,
        dataUpdatedAt: null,
        hint: '尚无数据，请先调用 POST /local/refresh 生成，再访问本接口',
      })
    }

    const allData = await getCompleteHostsData(c.env, forceRefresh)
    
    // 系统域名按分组过滤，用户自定义域名始终保留
    const allowedDomains = new Set(resolveGroupDomains(groupParam))
    const customList = await getCustomDomains(c.env)
    const customSet = new Set(customList.map((d) => d.domain))
    
    // 域名 → 所属分组（一个域名可以属于多个组，所以值是数组）
    const domainToGroups = new Map<string, string[]>()
    for (const group of SITE_GROUPS) {
      for (const domain of group.domains) {
        const list = domainToGroups.get(domain) ?? []
        list.push(group.id)
        domainToGroups.set(domain, list)
      }
    }

    const entries = allData.filter(
      ([, domain]) => allowedDomains.has(domain) || customSet.has(domain)
    )

    // 屏蔽清单里的域名不进结构化输出，避免客户端拿到「可用」的假象
    const blocked = await getBlocklist(c.env)
    const blockedSet = new Set(blocked.map((b) => b.domain))
    const visibleEntries = entries.filter(([, domain]) => !blockedSet.has(domain.toLowerCase()))

    /**
     * 合并内置与自定义，决定两件事：
     *   1. 最终 IP（自定义优先，符合"自定义优先级最高"）
     *   2. 归属分组（自定义显式指定的优先，否则沿用内置）
     */
    const builtinMap = new Map<string, string>()
    for (const [ip, domain] of visibleEntries) builtinMap.set(domain.toLowerCase(), ip)

    const merged = mergeCustomWithBuiltin({
      builtin: builtinMap,
      builtinGroups: domainToGroups,
      custom: (customList as CustomDomain[])
        .filter((d) => d.isActive !== false)
        .map((d) => ({
          domain: d.domain,
          // 用 customDomainAddrs 会补齐地址族（只给 v4 时自动加 ::）
          ips: customDomainAddrs(d),
          ip: d.ip,
          groups: d.groups,
        })),
      validGroupIds: new Set(SITE_GROUPS.map((g) => g.id)),
    })

    const visibleMerged = merged.filter((e) => !blockedSet.has(e.domain))

    // 按分组归类输出（多归属会在多个组里各出现一次）
    const byGroup: Record<string, Array<[string, string]>> = {}
    for (const group of SITE_GROUPS) {
      byGroup[group.id] = []
    }
    const customData: Array<[string, string]> = []

    for (const e of visibleMerged) {
      // 一个域名可能有多个地址，逐条展开
      if (e.groups.length === 0) {
        // 不属于任何内置分组的纯自定义域名
        for (const a of e.ips) customData.push([a, e.domain])
        continue
      }
      for (const gid of e.groups) {
        if (!byGroup[gid]) continue
        for (const a of e.ips) byGroup[gid].push([a, e.domain])
      }
    }

    // entries 用合并后的结果，保证与分组里的一致
    const finalEntries: Array<[string, string]> = visibleMerged.flatMap((e) =>
      e.ips.map((a) => [a, e.domain] as [string, string]),
    )

    // 添加缓存控制头，参考 TinsFox 最佳实践
    c.header('Cache-Control', forceRefresh ? 'no-cache' : 'public, max-age=3600') // 1小时缓存
    c.header('X-Cache-Status', forceRefresh ? 'MISS' : 'HIT')

    // 用数据自身更新时间，避免每次请求时间都不同
    const updatedAt = await getDataUpdatedAt(c.env)

    return c.json({
      entries: finalEntries,
      total: finalEntries.length,
      groups: SITE_GROUPS.filter((g) => byGroup[g.id].length > 0).map((g) => ({
        id: g.id,
        name: g.name,
        count: byGroup[g.id].length,
        entries: byGroup[g.id],
      })),
      github: byGroup['github'] ?? [],
      custom: customData,
      // 被自定义覆盖过 IP 的域名清单，便于排查"为什么不是我预期的地址"
      overrides: visibleMerged
        .filter((e) => e.overrode)
        .map((e) => ({ domain: e.domain, ip: e.ip, ips: e.ips })),
      includeCustom: true,
      timestamp: updatedAt ?? new Date().toISOString(),
      dataUpdatedAt: updatedAt,
      cacheStatus: forceRefresh ? 'refreshed' : 'cached'
    })
  } catch (error) {
    console.error("Error in /hosts.json:", error)
    return c.json({
      entries: [],
      total: 0,
      github: [],
      custom: [],
      includeCustom: true,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }, 500)
  }
})

/** 首启动保护：KV 为空时不要回落到慢速抓取路径，直接告诉使用者怎么生成数据 */
function noDataHint(c: Ctx) {
  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'no-store')
  return c.text(
    [
      '# custom-hosts 尚未生成数据',
      '#',
      '# 请先在控制台点击「开始刷新」，或执行：',
      '#   curl -X POST http://127.0.0.1:8788/local/refresh',
      '#',
      '# 刷新完成后再访问本地址即可获取 hosts 内容。',
    ].join('\n')
  )
}

/** 广告规则：默认跟随全局开关，?ads=false 临时关闭，?ads=true 强制带上 */
async function readAds(c: Ctx) {
  const param = c.req.query('ads')
  if (param === 'false') return null
  if (param === 'true') return await getAdsRules(c.env)
  if (!(await getAdsEnabled(c.env))) return null
  return await getAdsRules(c.env)
}

/** 取分组过滤后的条目（含自定义域名），/hosts 与 /host_fast 共用 */
async function collectEntries(
  c: Ctx,
  opts: { groupParam?: string; forceRefresh: boolean; includeCustom: boolean }
): Promise<HostEntry[]> {
  let allData = opts.includeCustom
    ? await getCompleteHostsData(c.env, opts.forceRefresh)
    : await getHostsData(c.env, opts.forceRefresh)

  if (opts.groupParam) {
    const allowedDomains = new Set(resolveGroupDomains(opts.groupParam))
    // custom=false 时自定义域名也不该混进分组输出，
    // 否则「只要 microsoft 组」的结果里会掺进一堆自己加的域名
    const customSet = opts.includeCustom
      ? new Set((await getCustomDomains(c.env)).map((d) => d.domain))
      : new Set<string>()
    allData = allData.filter(([, domain]) => allowedDomains.has(domain) || customSet.has(domain))
    console.log(`按分组 [${opts.groupParam}] 过滤后: ${allData.length} 条`)
  }
  return allData
}

function setHostsHeaders(c: Ctx, forceRefresh: boolean) {
  c.header('Cache-Control', forceRefresh ? 'no-cache' : 'public, max-age=3600')
  c.header('X-Cache-Status', forceRefresh ? 'MISS' : 'HIT')
  c.header('Content-Type', 'text/plain; charset=utf-8')
}

/**
 * /host 与 /hosts：优选 + 广告 + 自定义屏蔽的完整文件。
 * 屏蔽优先：同名域名只会出现在屏蔽区，优选区那一条被剔除。
 */
const hostsFull = async (c: Ctx, ipv4Only = false) => {
  try {
    const forceRefresh = c.req.query('refresh') === 'true'
    const groupParam = c.req.query('group')
    const includeCustom = c.req.query('custom') !== 'false'

    const dataAt = await getDataUpdatedAt(c.env)
    if (!dataAt) return noDataHint(c)

    const allData = await collectEntries(c, { groupParam, forceRefresh, includeCustom })
    const blocked = await getBlocklist(c.env)
    const ads = await readAds(c)
    // v4 通、v6 全废的域名：v4 照常加速，v6 写进屏蔽区
    const v6Broken = ipv4Only ? [] : await getV6BrokenDomains(c.env)
    // 用户暂停的内置规则：加速条目不输出，屏蔽条目不再堵死
    const [pausedAccel, pausedShield] = await Promise.all([getPausedAccel(), getPausedShield()])
    const content = formatHostsFile(
      allData, dataAt, ads, blocked, ipv4Only, v6Broken, pausedAccel, pausedShield
    )
    console.log(`[hosts] 全部条目 ${allData.length}，屏蔽 ${blocked.length}，长度 ${content.length}`)

    setHostsHeaders(c, forceRefresh)
    return c.text(content)
  } catch (error) {
    console.error('Error in /hosts:', error)
    return c.text(`# Error generating hosts file: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/** /host_fast：只有优选区，不含广告与屏蔽段；被屏蔽的域名同样不会出现 */
const hostsFast = async (c: Ctx, ipv4Only = false) => {
  try {
    const forceRefresh = c.req.query('refresh') === 'true'
    const groupParam = c.req.query('group')
    const includeCustom = c.req.query('custom') !== 'false'

    const dataAt = await getDataUpdatedAt(c.env)
    if (!dataAt) return noDataHint(c)

    const allData = await collectEntries(c, { groupParam, forceRefresh, includeCustom })
    const blocked = await getBlocklist(c.env)
    const pausedAccel = await getPausedAccel()
    const content = formatFastHosts(allData, dataAt, blocked, ipv4Only, pausedAccel)

    setHostsHeaders(c, forceRefresh)
    return c.text(content)
  } catch (error) {
    console.error('Error in /host_fast:', error)
    return c.text(`# Error: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/** /host_block：只有屏蔽段（广告规则 + 自定义屏蔽），每域名 v4/v6 各一条 */
const hostsBlock = async (c: Ctx) => {
  try {
    const blocked = await getBlocklist(c.env)
    const ads = await readAds(c)
    // 纯屏蔽端点在语义上是"只要 v4/v6 都不可达"，
    // 把仅 v6 坏的域名也带上会让只跑 v4 的环境误伤，所以这里不传
    const pausedShield = await getPausedShield()
    const content = formatBlockHosts(ads, blocked, null, pausedShield)
    if (!content) {
      c.header('Content-Type', 'text/plain; charset=utf-8')
      c.header('Cache-Control', 'no-store')
      return c.text('# 暂无屏蔽规则（自定义屏蔽为空，广告规则未启用或尚未抓取）\n')
    }
    c.header('Cache-Control', 'public, max-age=600')
    c.header('Content-Type', 'text/plain; charset=utf-8')
    return c.text(content)
  } catch (error) {
    console.error('Error in /host_block:', error)
    return c.text(`# Error: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

app.get('/hosts', (c) => hostsFull(c))
app.get('/host', (c) => hostsFull(c))
app.get('/host_fast', (c) => hostsFast(c))
app.get('/host_block', hostsBlock)
// 纯 v4 版本：少数环境（老路由器 / 无 IPv6 出口）用，剔除所有 IPv6 行
app.get('/host_v4', (c) => hostsFull(c, true))
app.get('/host_fast_v4', (c) => hostsFast(c, true))

// 自定义域名管理 API
app.get("/api/custom-domains", async (c) => {
  try {
    const customDomains = await getCustomDomains(c.env)
    return c.json(customDomains)
  } catch (error) {
    console.error("Error getting custom domains:", error)
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.post("/api/custom-domains", async (c) => {

  try {
    const body = await c.req.json()
    const { domain } = body

    if (!domain || typeof domain !== "string") {
      return c.json({ error: "Domain is required" }, 400)
    }

    // 简单的域名格式验证
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
      return c.json({ error: "Invalid domain format" }, 400)
    }

    const lower = domain.toLowerCase()

    // 内置域名不再拒绝：自定义优先级最高，允许覆盖内置的优选结果。
    // 这正是「如果此域名在其它规则里已存在，以自定义为准」的要求。
    const builtinGroup = SITE_GROUPS.find((g) => g.domains.includes(lower))

    const already = (await getCustomDomains(c.env)).find((x) => x.domain.toLowerCase() === lower)

    // 解析分组参数：非数组/未传都视为"不指定"
    const groups = Array.isArray(body.groups)
      ? body.groups.map((g: unknown) => String(g).trim().toLowerCase()).filter(Boolean)
      : undefined

    // 接受 ips 数组（多条），兼容旧的单个 ip
    const addrs = parseAddrInput(body.ips ?? body.ip ?? [])
    const result = await addCustomDomain(c.env, domain, addrs.length ? addrs : undefined, groups)

    if (result) {
      const message = result.isUpdate
        ? `域名 ${domain} 已存在，已更新其配置`
        : builtinGroup
          ? `域名 ${domain} 已添加，将覆盖内置分组「${builtinGroup.name}」的地址`
          : `域名 ${domain} 添加成功`

      return c.json({
        message,
        domain,
        result,
        isUpdate: result.isUpdate,
        // 让前端能提示"覆盖了内置条目"
        overridesBuiltin: Boolean(builtinGroup),
        builtinGroup: builtinGroup ? { id: builtinGroup.id, name: builtinGroup.name } : null,
        previousIp: already?.ip ?? null,
      })
    } else {
      return c.json({ error: "Failed to add domain or resolve IP" }, 500)
    }
  } catch (error) {
    return c.json({ error: "Invalid request body" }, 400)
  }
})

// 批量添加自定义域名 API
app.post("/api/custom-domains/batch", async (c) => {
  try {
    const body = await c.req.json()
    const { domains } = body

    if (!domains || !Array.isArray(domains)) {
      return c.json({ error: "Domains array is required" }, 400)
    }

    // 整批默认分组：单条没指定时用它
    const batchGroups = Array.isArray(body.groups)
      ? body.groups.map((g: unknown) => String(g).trim().toLowerCase()).filter(Boolean)
      : undefined

    const results = []
    const errors = []

    for (const domainData of domains) {
      const { domain } = domainData

      if (!domain || typeof domain !== "string") {
        errors.push({ domain: domain || "unknown", error: "Domain is required" })
        continue
      }

      // 简单的域名格式验证
      if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
        errors.push({ domain, error: "Invalid domain format" })
        continue
      }

      const lower = domain.toLowerCase()
      // 内置域名允许覆盖（自定义优先级最高）
      const builtinGroup = SITE_GROUPS.find((g) => g.domains.includes(lower))

      // 每条可单独带 groups，也可用整批的默认值
      const itemGroups = Array.isArray(domainData.groups)
        ? domainData.groups.map((g: unknown) => String(g).trim().toLowerCase()).filter(Boolean)
        : batchGroups

      try {
        const itemAddrs = parseAddrInput(domainData.ips ?? domainData.ip ?? [])
        const result = await addCustomDomain(
          c.env,
          domain,
          itemAddrs.length ? itemAddrs : undefined,
          itemGroups,
        )
        if (result) {
          const status = result.isUpdate ? "updated" : "success"
          results.push({
            domain,
            status,
            overridesBuiltin: Boolean(builtinGroup),
            builtinGroup: builtinGroup?.name ?? null,
          })
        } else {
          errors.push({ domain, error: "Failed to add domain" })
        }
      } catch (error) {
        errors.push({ domain, error: error instanceof Error ? error.message : "Unknown error" })
      }
    }

    return c.json({
      message: "Batch operation completed",
      added: results.length,
      failed: errors.length,
      results,
      errors
    })
  } catch (error) {
    return c.json({ error: "Invalid request body" }, 400)
  }
})

/**
 * 修改自定义域名的分组归属（不动 IP）。
 *
 * 单独开一个接口而不是复用 POST：改分组是高频轻操作，
 * 走 POST 会重新跑一次 DNS 解析、还可能被误当成"更新 IP"。
 */
app.patch("/api/custom-domains/:domain/groups", async (c) => {
  try {
    const domain = c.req.param("domain").toLowerCase()
    const body = await c.req.json().catch(() => ({}))
    const raw = Array.isArray(body.groups) ? body.groups : []

    const validIds = new Set(SITE_GROUPS.map((g) => g.id))
    const cleaned = raw
      .map((g: unknown) => String(g).trim().toLowerCase())
      .filter((g: string) => Boolean(g))

    // 只保留合法 id；all 特殊保留
    const groups = cleaned.filter((g: string) => g === "all" || validIds.has(g))
    const invalid = cleaned.filter((g: string) => g !== "all" && !validIds.has(g))

    const list = (await getCustomDomains(c.env)) as CustomDomain[]
    const idx = list.findIndex((x) => x.domain.toLowerCase() === domain)
    if (idx < 0) {
      return c.json({ error: `自定义域名中不存在 ${domain}` }, 404)
    }

    // 空数组表示"全部分组"，此时删掉字段而不是存空数组，保持数据干净
    if (groups.length === 0) {
      delete list[idx].groups
    } else {
      list[idx].groups = groups
    }

    await c.env.custom_hosts.put("custom_domains", JSON.stringify(list))
    await touchCustomChanged(c.env)

    return c.json({
      ok: true,
      domain,
      groups: groups.length ? groups : null,
      // 提示被忽略的非法值，避免用户以为设置成功了
      ignored: invalid,
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400)
  }
})

app.delete("/api/custom-domains/:domain", async (c) => {
  const domain = c.req.param("domain")
  const success = await removeCustomDomain(c.env, domain)

  if (success) {
    return c.json({ message: "Domain removed successfully", domain })
  } else {
    return c.json({ error: "Domain not found or failed to remove" }, 404)
  }
})




// 缓存管理 API - 参考 TinsFox/github-hosts 最佳实践
app.get("/api/cache/status", async (c) => {
  try {
    const kvData = (await c.env.custom_hosts.get("domain_data", {
      type: "json",
    })) as any

    if (!kvData) {
      return c.json({
        cached: false,
        message: "No cache data found"
      })
    }

    const lastUpdated = new Date(kvData.lastUpdated)
    const now = new Date()
    const ageMinutes = Math.round((now.getTime() - lastUpdated.getTime()) / 60000)
    // 与 services/hosts.ts 的 cacheValidTime 保持一致（3 小时）
    const cacheValidTime = 3 * 60
    const isValid = ageMinutes < cacheValidTime

    return c.json({
      cached: true,
      lastUpdated: kvData.lastUpdated,
      ageMinutes,
      isValid,
      validUntilMinutes: Math.max(0, cacheValidTime - ageMinutes),
      domainCount: Object.keys(kvData.domain_data || {}).length,
      updateCount: kvData.updateCount || 0,
      version: kvData.version || "unknown"
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})






// 通用路由处理
app.get("*", async (c) => {
  const path = c.req.path
  
  // 检查是否是域名查询路径
  if (path !== "/" && !path.startsWith("/api/") && !path.startsWith("/hosts") && path !== "/favicon.ico") {
    const domain = path.substring(1) // 移除开头的 /
    
    // 简单验证是否是域名格式
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
      const data = await getDomainData(c.env, domain)

      if (!data) {
        return c.json({ error: "Domain not found" }, 404)
      }

      return c.json(data)
    }
  }
  
  // 默认返回 404
  return c.text("Not Found", 404)
})

// 全局错误处理：把未捕获异常的真实信息返回给调用方，
// 否则本地只能看到一个没有上下文的 500 响应。
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : ''
  return c.text(`ERROR: ${message}\n\n${stack}`, 500)
})

// 本地版只有 HTTP 入口：定时刷新由 server/ 的调度与本控制台的
// /local/refresh 负责，不再需要 Workers 的 scheduled 事件。
export default {
  fetch: app.fetch,
}
