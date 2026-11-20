import { Hono } from "hono"
import {
  formatHostsFile,
  getDomainData,
  getCompleteHostsData,
  getHostsData,
  getDataUpdatedAt,
  getCustomDomains,
  addCustomDomain,
  removeCustomDomain,
  type HostEntry,
} from "./services/hosts"
import { SITE_GROUPS, resolveGroupDomains } from "./constants"
import { Bindings } from "./types"

const app = new Hono<{ Bindings: Bindings }>()

// 本地版不做权限控制，也不再需要管理后台页面：
// 控制台（public/console.html）已取代原内联管理页。


app.get("/hosts.json", async (c) => {
  try {
    // 检查是否强制刷新缓存
    const forceRefresh = c.req.query('refresh') === 'true'
    // 站点分组过滤：?group=github,npm，不传则输出全部
    const groupParam = c.req.query('group')
    
    console.log(`JSON request - refresh: ${forceRefresh}, group: ${groupParam || 'all'}`)
    
    const allData = await getCompleteHostsData(c.env, forceRefresh)
    
    // 系统域名按分组过滤，用户自定义域名始终保留
    const allowedDomains = new Set(resolveGroupDomains(groupParam))
    const customList = await getCustomDomains(c.env)
    const customSet = new Set(customList.map((d) => d.domain))
    
    const domainToGroup = new Map<string, string>()
    for (const group of SITE_GROUPS) {
      for (const domain of group.domains) {
        domainToGroup.set(domain, group.id)
      }
    }
    
    const entries = allData.filter(
      ([, domain]) => allowedDomains.has(domain) || customSet.has(domain)
    )
    
    // 按分组归类输出
    const byGroup: Record<string, Array<[string, string]>> = {}
    for (const group of SITE_GROUPS) {
      byGroup[group.id] = []
    }
    const customData: Array<[string, string]> = []
    
    for (const entry of entries) {
      const groupId = domainToGroup.get(entry[1])
      if (groupId && byGroup[groupId]) {
        byGroup[groupId].push(entry)
      } else {
        customData.push(entry)
      }
    }

    // 添加缓存控制头，参考 TinsFox 最佳实践
    c.header('Cache-Control', forceRefresh ? 'no-cache' : 'public, max-age=3600') // 1小时缓存
    c.header('X-Cache-Status', forceRefresh ? 'MISS' : 'HIT')

    // 用数据自身更新时间，避免每次请求时间都不同
    const updatedAt = await getDataUpdatedAt(c.env)

    return c.json({
      entries,
      total: entries.length,
      groups: SITE_GROUPS.filter((g) => byGroup[g.id].length > 0).map((g) => ({
        id: g.id,
        name: g.name,
        count: byGroup[g.id].length,
        entries: byGroup[g.id],
      })),
      github: byGroup['github'] ?? [],
      custom: customData,
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

app.get("/hosts", async (c) => {
  try {
    // 获取查询参数
    const forceRefresh = c.req.query('refresh') === 'true'
    const optimizeParam = c.req.query('optimize')
    const customParam = c.req.query('custom')
    const groupParam = c.req.query('group')
    
    // 默认启用所有功能
    const enableOptimization = optimizeParam !== 'false'
    const includeCustomDomains = customParam !== 'false'
    
    console.log(`Hosts request - refresh: ${forceRefresh}, optimize: ${enableOptimization}, custom: ${includeCustomDomains}, group: ${groupParam || 'all'}`)
    
    let allData: HostEntry[]
    
    if (includeCustomDomains) {
      // 包含自定义域名的完整数据
      allData = await getCompleteHostsData(c.env, forceRefresh)
      console.log(`合并后总数据 (包含自定义域名): ${allData.length} 条`)
    } else {
      // 仅系统域名数据
      allData = await getHostsData(c.env, forceRefresh)
      console.log(`系统域名数据: ${allData.length} 条`)
    }
    
    // 站点分组过滤：传了 group 才过滤，自定义域名始终保留
    if (groupParam) {
      const allowedDomains = new Set(resolveGroupDomains(groupParam))
      const customList = await getCustomDomains(c.env)
      const customSet = new Set(customList.map((d) => d.domain))
      allData = allData.filter(
        ([, domain]) => allowedDomains.has(domain) || customSet.has(domain)
      )
      console.log(`按分组 [${groupParam}] 过滤后: ${allData.length} 条`)
    }
    
    const updatedAt = await getDataUpdatedAt(c.env)
    const hostsContent = formatHostsFile(allData, updatedAt)
    console.log(`生成的hosts文件长度: ${hostsContent.length} 字符`)
    
    // 添加缓存控制头
    c.header('Cache-Control', forceRefresh ? 'no-cache' : 'public, max-age=3600') // 1小时缓存
    c.header('X-Cache-Status', forceRefresh ? 'MISS' : 'HIT')
    c.header('Content-Type', 'text/plain; charset=utf-8')
    
    return c.text(hostsContent)
  } catch (error) {
    console.error("Error in /hosts:", error)
    return c.text(`# Error generating hosts file: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
})


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

    const result = await addCustomDomain(c.env, domain)

    if (result) {
      const message = result.isUpdate 
        ? `域名 ${domain} 已存在，已更新其配置` 
        : `域名 ${domain} 添加成功`
        
      return c.json({ 
        message, 
        domain, 
        result,
        isUpdate: result.isUpdate 
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

      try {
        const result = await addCustomDomain(c.env, domain)
        if (result) {
          const status = result.isUpdate ? "updated" : "success"
          results.push({ domain, status })
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
    // 与 services/hosts.ts 的 cacheValidTime 保持一致（3 小时，略大于 2 小时的 cron 周期）
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
// 避免线上只看到 Cloudflare 的 1101 页面而无从定位。
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
