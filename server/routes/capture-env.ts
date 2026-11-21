/**
 * 抓包环境自检：GET /local/capture/env
 *
 * 挂载方式（由主 agent 在 server/index.ts 里加，本文件不自己挂）：
 *
 *   root.route("/local/capture", createCaptureEnvRoutes(() => process.env.CAPTURE_CDP_URL || DEFAULT_CDP_URL))
 *
 * 设计取舍：
 * - 探测失败一律返回 HTTP 200 + { cdp: false, error }，不用 5xx。
 *   "Chromium 没起来"是**预期的正常状态**（capture profile 默认不启动），
 *   前端靠 cdp 字段给提示；返回 5xx 会让控制台的通用错误处理弹红色报错，
 *   也会污染监控里的错误率。
 * - 只有 2s 超时：CDP 在同一台机器/同一个 docker 网络里，正常 < 20ms；
 *   等太久会把控制台的首屏拖成白屏。
 */
import { Hono } from "hono"

/**
 * 运行时由 B 在 server/capture/types.ts 里定义，此处按 docs/orchestration/contracts/api-capture.md §1
 * 做一份结构完全一致的本地声明，避免本 lane 依赖尚未合并的文件。
 */
export interface CaptureEnv {
  /** CDP 是否可达 */
  cdp: boolean
  /** Chromium / Chrome 版本，例如 126.0.6478.182 */
  version?: string
  /** 容器内浏览器标识（CDP /json/version 的 Browser 字段），便于排查 */
  chromium?: string
  /** 探测失败原因，中文，可直接展示 */
  error?: string
}

/** 默认 CDP 地址：chromium 容器把 9222 只绑在宿主 loopback 上（见 docker-compose.yml） */
export const DEFAULT_CDP_URL = "http://127.0.0.1:9222"

/** 优先读环境变量，方便 NAS 上换端口而不用改代码 */
export function resolveCdpUrl(): string {
  const fromEnv = (process.env.CAPTURE_CDP_URL || "").trim()
  return fromEnv || DEFAULT_CDP_URL
}

/** CDP /json/version 的返回里我们只关心这几个字段 */
interface CdpVersion {
  Browser?: string
  "User-Agent"?: string
  webSocketDebuggerUrl?: string
}

const PROBE_TIMEOUT_MS = 2000

/** 把 "Chrome/126.0.6478.182" 或 UA 里的版本号抽成 "126.0.6478.182" */
function pickVersion(info: CdpVersion): string | undefined {
  const fromBrowser = /(?:Chrome|Chromium)\/([\d.]+)/.exec(info.Browser || "")
  if (fromBrowser) return fromBrowser[1]

  const ua = info["User-Agent"] || ""
  const fromUa = /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua)
  return fromUa?.[1]
}

/** 把异常压成一句人能看懂的话，避免把 "fetch failed" 这种原文直接丢给用户 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `CDP 探测超时（>${PROBE_TIMEOUT_MS}ms）`
    }
    // Node 的 fetch 失败信息通常藏在 cause 里
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    if (cause && typeof cause === "object" && "code" in cause) {
      return String((cause as { code?: unknown }).code)
    }
    return err.message || err.name
  }
  return String(err)
}

async function probeCdp(baseUrl: string): Promise<CaptureEnv> {
  // 去掉末尾斜杠，避免拼出 //json/version
  const base = baseUrl.replace(/\/+$/, "")
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })

    if (!res.ok) {
      return { cdp: false, error: `CDP 返回 HTTP ${res.status}` }
    }

    const info = (await res.json()) as CdpVersion
    // 只有拿到 webSocketDebuggerUrl 才算真的可用：抓包后端要靠它建 WS
    if (!info.webSocketDebuggerUrl) {
      return { cdp: false, error: "CDP 响应缺少 webSocketDebuggerUrl" }
    }

    return {
      cdp: true,
      version: pickVersion(info),
      chromium: info.Browser,
    }
  } catch (err) {
    return { cdp: false, error: describeError(err) }
  }
}

/**
 * @param getCdpUrl 每次请求时调用，返回 CDP 基础地址（如 http://127.0.0.1:9222）。
 *                  做成函数而非字符串，是为了支持运行期改端口/改地址而不必重启。
 */
export function createCaptureEnvRoutes(getCdpUrl: () => string): Hono {
  const routes = new Hono()

  routes.get("/env", async (c) => {
    const env = await probeCdp(getCdpUrl())
    // 状态是实时的，任何一层缓存都会让"刚启动的 Chromium 仍然显示不可用"
    c.header("Cache-Control", "no-store")
    return c.json(env)
  })

  return routes
}
