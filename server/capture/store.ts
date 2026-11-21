/**
 * 抓包会话落盘。
 *
 * 为什么要落盘：控制台「网页诊断」的会话历史要跨进程重启保留——
 * 用户抓完一轮、重启服务、再回来看"刚才哪几个域名慢"是常见用法。
 * 内存里的会话在 stop 后会被释放，所以 stop 必须把结果写下来。
 *
 * 保留最近 20 个（契约 §2 的 limit=20 与之一致）。超过就按 startedAt 从旧到新删，
 * 不做压缩：单个会话几十到几百 KB，20 个文件最多几 MB，压缩反而让排查时要多解一次。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CaptureSession, CapturedRequest } from './types.ts'

/** 保留的会话数量上限 */
export const RETAIN_SESSIONS = 20

/**
 * 会话 id 白名单。id 直接拼进文件名，必须挡住 `../` 之类的路径穿越——
 * 这个接口虽然要登录，但同一台 NAS 上可能有多人用同一个密码。
 */
const ID_PATTERN = /^capture-[A-Za-z0-9_-]{1,80}$/

export interface StoredSession {
  session: CaptureSession
  requests: CapturedRequest[]
}

function dir(): string {
  // 与 server/blocked.ts、server/kv.ts 一致：全部运行时数据落在 cwd/data 下（已 gitignore）
  return path.resolve(process.cwd(), 'data/capture')
}

function fileOf(id: string): string | null {
  if (!ID_PATTERN.test(id)) return null
  return path.join(dir(), `${id}.json`)
}

/** 原子写：先写 .tmp 再 rename，避免进程在写一半时被杀留下半截 JSON */
export async function saveSession(record: StoredSession): Promise<void> {
  const file = fileOf(record.session.id)
  if (!file) throw new Error(`非法的会话 id：${record.session.id}`)
  await fs.mkdir(dir(), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(record), 'utf8')
  await fs.rename(tmp, file)
  await pruneSessions()
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  const file = fileOf(id)
  if (!file) return null
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as StoredSession
    if (!parsed?.session?.id || !Array.isArray(parsed.requests)) return null
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // 损坏的文件不该让整个列表接口 500，按"没有这个会话"处理并留下日志
    console.error('[capture] 读取会话失败', id, err instanceof Error ? err.message : err)
    return null
  }
}

/** 磁盘上的会话，按 startedAt 倒序 */
export async function listStoredSessions(limit = RETAIN_SESSIONS): Promise<CaptureSession[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir())
  } catch {
    return []
  }
  const sessions: CaptureSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stored = await loadSession(name.slice(0, -'.json'.length))
    if (stored) sessions.push(stored.session)
  }
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return sessions.slice(0, Math.max(1, limit))
}

/**
 * 删除单个会话文件。返回是否真的删掉了：
 * - false 表示文件不存在（调用方按 404 处理）
 * - 抛错表示文件存在但删不掉（权限/占用），调用方按 500 处理
 *
 * 不做"删不掉就忽略"的处理——用户点了清理却说成功，比报错更糟。
 */
export async function deleteSession(id: string): Promise<boolean> {
  const file = fileOf(id)
  if (!file) return false
  try {
    await fs.unlink(file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * 清空会话文件，返回删除数量。
 *
 * `except` 里的 id 会保留（用于"正在抓包的不删"）。按文件名匹配而不是先解析内容，
 * 这样列表接口读不出来的损坏文件也能被清掉——"清空全部"就该真的空。
 * 单个文件删失败不影响其余，只影响计数。
 */
export async function clearStoredSessions(except: ReadonlySet<string> = new Set()): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(dir())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (except.has(id)) continue
    const file = fileOf(id)
    if (!file) continue
    try {
      await fs.unlink(file)
      removed += 1
    } catch {
      /* 单个失败继续删下一个 */
    }
  }
  return removed
}

/**
 * 只保留最近 retain 个会话。删除失败的忽略：
 * 磁盘满/权限不足时，宁可多留几个文件也不能让 stop 接口整个失败——
 * 用户已经抓完的数据比"目录整齐"重要得多。
 */
export async function pruneSessions(retain = RETAIN_SESSIONS): Promise<number> {
  const sessions = await listStoredSessions(Number.MAX_SAFE_INTEGER)
  const stale = sessions.slice(retain)
  let removed = 0
  for (const session of stale) {
    const file = fileOf(session.id)
    if (!file) continue
    try {
      await fs.unlink(file)
      removed += 1
    } catch {
      /* 忽略 */
    }
  }
  return removed
}
