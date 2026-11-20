/**
 * 网络环境变化检测。
 *
 * 思路：用公网出口 IP 作为「网络身份」。设备换了 WiFi、切到手机热点、
 * 挂上或断开 VPN，出口 IP 必然变化，此时 IP 延迟缓存全部失效。
 *
 * 检测时机为什么放在「刷新开始时」而不是后台每分钟轮询：
 *   1. 缓存只在刷新时被读取，其余时间的检测完全空转。
 *      若每天刷新 2 次，每分钟轮询等于 1440 次里有 1438 次白跑。
 *   2. ipinfo.io 免费额度约 5 万次/月，每分钟轮询是 4.32 万次/月，
 *      占用 86%，几乎没有余量。改为刷新时检测后降到个位数。
 *   3. 刷新前检测的语义更准确：「上次刷新到现在，网络是否变了」，
 *      而每分钟轮询还得额外判断「这次变化是否已被处理」。
 *
 * 已知局限：出口 IP 不变不代表延迟没变。实测同一 IP 在 24 秒内
 * 延迟波动 12~30%（晚高峰、路由调整、CDN 重调度都不改出口 IP）。
 * 因此本检测只解决「换网络」这一类，其余靠 TTL 兜底。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.resolve(process.cwd(), "data/network-identity.json")

interface IdentityFile {
  /** 上次记录的出口 IP */
  publicIp: string
  /** 记录时间 */
  at: string
}

export interface NetCheckResult {
  /** 当前出口 IP；获取失败为 null */
  currentIp: string | null
  /** 上次记录时的出口 IP */
  previousIp: string | null
  /** 是否检测到网络变化 */
  changed: boolean
  /** 本次检测是否可信（取不到 IP 时为 false，此时不应清缓存） */
  reliable: boolean
  /** 说明，便于日志与前端展示 */
  note: string
  /** 检测耗时 */
  ms: number
}

/**
 * 查询出口 IP。优先 ipinfo.io，失败则退回国内服务。
 * 任一成功即可，都失败则返回 null。
 */
async function fetchPublicIp(timeoutMs = 5000): Promise<string | null> {
  const sources = [
    {
      name: "ipinfo.io",
      url: "https://ipinfo.io/json",
      pick: (j: any) => (typeof j?.ip === "string" ? j.ip : null),
    },
    {
      name: "myip.ipip.net",
      url: "https://myip.ipip.net",
      pick: (t: string) => {
        const m = t.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
        return m ? m[1] : null
      },
    },
  ]

  for (const s of sources) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(s.url, { signal: controller.signal })
      if (!res.ok) continue
      const text = await res.text()
      let ip: string | null
      if (s.name === "ipinfo.io") {
        try {
          ip = s.pick(JSON.parse(text))
        } catch {
          ip = null
        }
      } else {
        ip = s.pick(text)
      }
      if (ip) return ip
    } catch {
      // 换下一个源
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

async function readIdentity(): Promise<IdentityFile | null> {
  try {
    const raw = await fs.readFile(FILE, "utf8")
    return JSON.parse(raw) as IdentityFile
  } catch {
    return null
  }
}

async function writeIdentity(ip: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true })
    const payload: IdentityFile = { publicIp: ip, at: new Date().toISOString() }
    await fs.writeFile(FILE, JSON.stringify(payload, null, 2), "utf8")
  } catch (err) {
    console.error("[netcheck] 写入失败", (err as Error).message)
  }
}

/**
 * 检测网络是否变化。首次运行（无记录）视为「未变化」，
 * 只记录基线——否则第一次刷新就会把刚建立的缓存清掉。
 */
export async function checkNetworkChange(): Promise<NetCheckResult> {
  const t0 = Date.now()
  const prev = await readIdentity()
  const currentIp = await fetchPublicIp()
  const ms = Date.now() - t0

  if (!currentIp) {
    return {
      currentIp: null,
      previousIp: prev?.publicIp ?? null,
      changed: false,
      reliable: false,
      note: "无法获取出口 IP，跳过网络变化判断（不清空缓存）",
      ms,
    }
  }

  if (!prev) {
    await writeIdentity(currentIp)
    return {
      currentIp,
      previousIp: null,
      changed: false,
      reliable: true,
      note: "首次记录出口 IP，作为后续比对基线",
      ms,
    }
  }

  if (prev.publicIp !== currentIp) {
    await writeIdentity(currentIp)
    return {
      currentIp,
      previousIp: prev.publicIp,
      changed: true,
      reliable: true,
      note: `出口 IP 由 ${prev.publicIp} 变为 ${currentIp}，网络环境已变化`,
      ms,
    }
  }

  // IP 未变，更新记录时间即可
  await writeIdentity(currentIp)
  return {
    currentIp,
    previousIp: prev.publicIp,
    changed: false,
    reliable: true,
    note: "出口 IP 未变化，缓存可继续使用",
    ms,
  }
}
