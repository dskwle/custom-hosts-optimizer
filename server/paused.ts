/**
 * 内置站点的「暂停」开关（持久化）。
 *
 * 内置加速来自 src/constants.ts 的 SITE_GROUPS，内置屏蔽来自 BUILTIN 常量，
 * 两者都写死在代码里。用户偶尔需要临时停掉某一条（比如某域名当前用不上、
 * 或内置屏蔽误伤了要用的服务），但直接改代码显然不现实。
 *
 * 所以单独存一份「暂停名单」：
 *   - 暂停加速：该域名不再写入 hosts 优选区，也不再参与刷新探测
 *   - 暂停屏蔽：该域名不再写入 0.0.0.0 / :: 屏蔽行，恢复它本来的可达性
 *
 * 为什么存两个独立集合而不是一个带标记的列表：两种暂停语义完全不同，
 * 一个域名完全可能同时被「内置加速」和「内置屏蔽」命中（屏蔽优先），
 * 分开存才不会有歧义。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.resolve(process.cwd(), "data/paused-builtin.json")

export interface PausedState {
  /** 暂停加速的内置域名 */
  accel: string[]
  /** 暂停屏蔽的内置域名 */
  shield: string[]
  updatedAt: string
}

const EMPTY: PausedState = { accel: [], shield: [], updatedAt: "" }

let cache: PausedState | null = null

async function load(): Promise<PausedState> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<PausedState>
    cache = {
      accel: Array.isArray(parsed.accel) ? parsed.accel.filter((d) => typeof d === "string") : [],
      shield: Array.isArray(parsed.shield) ? parsed.shield.filter((d) => typeof d === "string") : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[paused] 读取失败，按空状态处理", err.message)
    }
    cache = { ...EMPTY }
  }
  return cache
}

async function save(state: PausedState): Promise<void> {
  const next: PausedState = {
    accel: [...new Set(state.accel.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort(),
    shield: [...new Set(state.shield.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort(),
    updatedAt: new Date().toISOString(),
  }
  cache = next
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8")
  await fs.rename(tmp, FILE)
}

export async function getPaused(): Promise<PausedState> {
  return { ...(await load()) }
}

export async function getPausedAccel(): Promise<Set<string>> {
  return new Set((await load()).accel)
}

export async function getPausedShield(): Promise<Set<string>> {
  return new Set((await load()).shield)
}

/**
 * 设置某内置域名的暂停状态。
 * kind: 'accel' 暂停加速 / 'shield' 暂停屏蔽
 */
export async function setPaused(
  domain: string,
  kind: "accel" | "shield",
  paused: boolean,
): Promise<void> {
  const d = domain.trim().toLowerCase()
  if (!d) return
  const state = await load()
  const list = new Set(state[kind])
  if (paused) list.add(d)
  else list.delete(d)
  await save({ ...state, [kind]: [...list] })
}

/** 批量设置，返回实际改动数 */
export async function setPausedMany(
  domains: readonly string[],
  kind: "accel" | "shield",
  paused: boolean,
): Promise<number> {
  const state = await load()
  const list = new Set(state[kind])
  const before = list.size
  for (const raw of domains) {
    const d = String(raw ?? "").trim().toLowerCase()
    if (!d) continue
    if (paused) list.add(d)
    else list.delete(d)
  }
  await save({ ...state, [kind]: [...list] })
  return Math.abs(list.size - before)
}

/** 清空所有暂停（恢复出厂的内置规则） */
export async function clearPaused(): Promise<void> {
  await save({ accel: [], shield: [], updatedAt: "" })
}
