/**
 * `/clash/*` 公开端点（与 /host* 同级，无需 Basic Auth）。
 *
 * 为什么是工厂函数而不是直接导出 Hono 实例：
 * 业务代码只认 `env.custom_hosts`（KV），而 env 由 server/index.ts 在启动时创建。
 * 导出 `createClashRoutes(getEnv)` 让挂载方决定 env 从哪来，
 * 这个文件因此既不需要 import server/index.ts，也不用读 process.env，
 * 单测/临时脚本可以塞一个假 KV 进来。
 *
 * 五个端点的输出全部是 YAML（text/yaml; charset=utf-8），并带 300 秒公共缓存：
 * mihomo 的 rule-provider interval 是 7200 秒，hosts 段由用户手动粘，
 * 300 秒足够吸收重复拉取，又不会让新加的屏蔽域名迟迟不生效。
 *
 * 任何一段数据源异常都降级为空结构而不是 500：
 * YAML 语法错会让 mihomo 整份配置加载失败，用户看到的是"代理直接不工作"，
 * 远比"少了几条规则"严重。
 */
import { Hono, type Context } from "hono"
import type { Bindings } from "../../src/types.js"
import { getCompleteHostsData, getDataUpdatedAt } from "../../src/services/hosts.js"
import { getPausedAccel, getPausedShield } from "../paused.js"
import { getBlocklist } from "../../src/services/blocklist.js"
import { getAdsRules } from "../../src/services/ads.js"
import { listBlocked } from "../blocked.js"
import { buildClashHosts, formatClashHostsYaml } from "../../src/clash/hosts.js"
import { buildDomainPayload, formatPayloadYaml } from "../../src/clash/payload.js"
import { formatAdsYaml } from "../../src/clash/ads.js"
import { DEFAULT_INTERVAL, buildExampleConfigYaml, buildSnippetYaml } from "../../src/clash/snippet.js"

const CACHE_CONTROL = "public, max-age=300"

function sendYaml(c: Context, body: string): Response {
  c.header("Content-Type", "text/yaml; charset=utf-8")
  c.header("Cache-Control", CACHE_CONTROL)
  return c.body(body)
}

/**
 * 公网/局域网地址：优先取 ?base= 显式指定，否则用本次请求的 origin。
 * 需要显式指定是因为 mihomo 可能在容器里，看到的本服务地址和浏览器不一样。
 */
function resolveBaseUrl(c: Context): string {
  const q = (c.req.query("base") || "").trim()
  if (q) return q.replace(/\/+$/, "")
  try {
    return new URL(c.req.url).origin
  } catch {
    return ""
  }
}

function resolveProxyGroup(c: Context): string {
  const q = (c.req.query("proxy") || "").trim()
  return q || "PROXY"
}

/** 统一的降级包装：数据源抛错时返回空 YAML，只记日志 */
async function safeYaml(
  label: string,
  fn: () => Promise<string>,
  empty: string
): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[clash] ${label} 生成失败，降级为空结构：`, err)
    return empty
  }
}

export function createClashRoutes(getEnv: () => Bindings): Hono {
  const app = new Hono()

  /** 加速：域名 → [ip, ...]（含 IPv6），屏蔽域名已剔除 */
  app.get("/hosts.yaml", async (c) => {
    const yaml = await safeYaml(
      "hosts.yaml",
      async () => {
        const env = getEnv()
        const [allEntries, blocked, updatedAt, pausedAccel] = await Promise.all([
          getCompleteHostsData(env, false),
          getBlocklist(env),
          getDataUpdatedAt(env),
          getPausedAccel(),
        ])
        // 暂停加速的域名不进 hosts 段，与 /host 的输出保持一致
        const entries = allEntries.filter(([, d]) => !pausedAccel.has(d.toLowerCase()))
        const hosts = buildClashHosts(entries, { blocked: blocked.map((b) => b.domain) })
        return formatClashHostsYaml(hosts, { updatedAt })
      },
      "# custom-hosts 优选地址 · 数据暂不可用\nhosts: {}\n"
    )
    return sendYaml(c, yaml)
  })

  /** 纯 v4 的 hosts 映射：少数环境无 IPv6，剔除所有 IPv6 地址 */
  app.get("/hosts-v4.yaml", async (c) => {
    const yaml = await safeYaml(
      "hosts-v4.yaml",
      async () => {
        const env = getEnv()
        const [allEntries, blocked, updatedAt, pausedAccel] = await Promise.all([
          getCompleteHostsData(env, false),
          getBlocklist(env),
          getDataUpdatedAt(env),
          getPausedAccel(),
        ])
        const entries = allEntries.filter(([, d]) => !pausedAccel.has(d.toLowerCase()))
        const hosts = buildClashHosts(entries, {
          blocked: blocked.map((b) => b.domain),
          ipv4Only: true,
        })
        return formatClashHostsYaml(hosts, { updatedAt })
      },
      "# custom-hosts 优选地址（纯 IPv4）· 数据暂不可用\nhosts: {}\n"
    )
    return sendYaml(c, yaml)
  })

  /** 屏蔽清单（内置 + 手动），只给域名，behavior: domain */
  app.get("/block.yaml", async (c) => {
    const yaml = await safeYaml(
      "block.yaml",
      async () => {
        const [allEntries, pausedShield] = await Promise.all([
          getBlocklist(getEnv()),
          getPausedShield(),
        ])
        // 暂停屏蔽的条目不再 REJECT，与 /host_block 保持一致
        const entries = allEntries.filter((e) => !pausedShield.has(e.domain.toLowerCase()))
        const payload = buildDomainPayload(entries.map((e) => e.domain))
        const builtin = entries.filter((e) => e.builtin).length
        return formatPayloadYaml(payload.domains, {
          title: "custom-hosts · 屏蔽清单（内置 + 手动）",
          notes: [
            `内置 ${builtin} 条 + 手动 ${entries.length - builtin} 条`,
            "行为：命中即 REJECT；与 /clash/ads.yaml 分开，便于单独开关广告规则",
          ],
          skippedCount: payload.skipped.length,
        })
      },
      "# custom-hosts 屏蔽清单 · 数据暂不可用\npayload: []\n"
    )
    return sendYaml(c, yaml)
  })

  /** 广告规则：从缓存的 hosts 写法里抽域名，与主屏蔽清单去重 */
  app.get("/ads.yaml", async (c) => {
    const yaml = await safeYaml(
      "ads.yaml",
      async () => {
        const env = getEnv()
        const [meta, blocked, pausedShield] = await Promise.all([
          getAdsRules(env),
          getBlocklist(env),
          getPausedShield(),
        ])
        // exclude 里去掉已暂停屏蔽的域名，否则广告规则会绕过暂停继续拦截
        return formatAdsYaml(meta?.content ?? "", {
          fetchedAt: meta?.fetchedAt ?? null,
          version: meta?.version ?? null,
          exclude: blocked.map((b) => b.domain).filter((d) => !pausedShield.has(d.toLowerCase())),
        }).yaml
      },
      "# custom-hosts 广告规则 · 数据暂不可用\npayload: []\n"
    )
    return sendYaml(c, yaml)
  })

  /** SNI 阻断域名：改 hosts 无效，交给用户的策略组（默认 PROXY） */
  app.get("/proxy.yaml", async (c) => {
    const yaml = await safeYaml(
      "proxy.yaml",
      async () => {
        const entries = await listBlocked()
        const payload = buildDomainPayload(entries.map((e) => e.domain))
        return formatPayloadYaml(payload.domains, {
          title: "custom-hosts · SNI 阻断域名（建议走代理）",
          notes: [
            "这些域名在 TLS 握手阶段被按域名切断，改 hosts 无效，只能换出口节点",
            "在 rules 里映射成 RULE-SET,ch-proxy,<你的策略组名>",
          ],
          skippedCount: payload.skipped.length,
        })
      },
      "# custom-hosts SNI 阻断清单 · 数据暂不可用\npayload: []\n"
    )
    return sendYaml(c, yaml)
  })

  /** 合并片段：hosts + rule-providers + rules，整段可粘 */
  app.get("/snippet.yaml", async (c) => {
    const yaml = await safeYaml(
      "snippet.yaml",
      async () => {
        const env = getEnv()
        const [entries, blocked, updatedAt] = await Promise.all([
          getCompleteHostsData(env, false),
          getBlocklist(env),
          getDataUpdatedAt(env),
        ])
        const hosts = buildClashHosts(entries, { blocked: blocked.map((b) => b.domain) })
        return buildSnippetYaml({
          baseUrl: resolveBaseUrl(c),
          proxyGroup: resolveProxyGroup(c),
          hosts,
          generatedAt: updatedAt ?? Date.now(),
          interval: DEFAULT_INTERVAL,
        })
      },
      `# custom-hosts 片段 · 数据暂不可用\nhosts: {}\nrule-providers: {}\nrules: []\n`
    )
    return sendYaml(c, yaml)
  })

  /** 完整模板：dns.use-hosts + fake-ip + tun 注释 + proxy-groups 占位 */
  app.get("/config.example.yaml", async (c) => {
    const yaml = await safeYaml(
      "config.example.yaml",
      async () => {
        const env = getEnv()
        const [entries, blocked, updatedAt] = await Promise.all([
          getCompleteHostsData(env, false),
          getBlocklist(env),
          getDataUpdatedAt(env),
        ])
        const hosts = buildClashHosts(entries, { blocked: blocked.map((b) => b.domain) })
        return buildExampleConfigYaml({
          baseUrl: resolveBaseUrl(c),
          proxyGroup: resolveProxyGroup(c),
          hosts,
          generatedAt: updatedAt ?? Date.now(),
          interval: DEFAULT_INTERVAL,
        })
      },
      `# custom-hosts 配置模板 · 数据暂不可用\nhosts: {}\nrules: []\n`
    )
    return sendYaml(c, yaml)
  })

  return app
}
