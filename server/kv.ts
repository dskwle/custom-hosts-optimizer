/**
 * 本地 KV 实现：用文件系统模拟 Cloudflare KV 的接口。
 *
 * 目的是让 src/ 下的业务代码不做任何修改就能在 Node 里跑起来——
 * 所有调用都走 env.custom_hosts.get / put / delete / list，
 * 只要这个适配器签名一致，业务逻辑就无需感知运行环境。
 *
 * 数据落在 data/kv/<key>.json，每个 key 一个文件，方便直接查看和手工修正。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const KV_DIR = path.resolve(process.cwd(), "data/kv")

function keyToPath(key: string): string {
  // 文件名里不能出现 / 等特殊字符，做个可逆转义
  const safe = encodeURIComponent(key)
  return path.join(KV_DIR, `${safe}.json`)
}

function parseGetOptions(options?: any): { type?: "text" | "json" | "arrayBuffer" | "stream" } {
  if (!options) return {}
  if (typeof options === "string") return { type: options as any }
  return options
}

export class FileKV {
  private cache = new Map<string, { value: string; expiresAt?: number }>()

  async get(key: string, options?: any): Promise<any> {
    const opts = parseGetOptions(options)
    const raw = await this.readRaw(key)
    if (raw === null) return null

    if (opts.type === "json") {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    if (opts.type === "arrayBuffer") {
      return new TextEncoder().encode(raw).buffer
    }
    return raw
  }

  private async readRaw(key: string): Promise<string | null> {
    // 命中内存缓存可避免高频读取时的磁盘 IO
    const hit = this.cache.get(key)
    if (hit) {
      if (hit.expiresAt && hit.expiresAt < Date.now()) {
        this.cache.delete(key)
        return null
      }
      return hit.value
    }

    try {
      const text = await fs.readFile(keyToPath(key), "utf8")
      // 文件内容形如 {"value": "...", "expiresAt": 123}
      const parsed = JSON.parse(text) as { value: string; expiresAt?: number }
      if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
        return null
      }
      this.cache.set(key, parsed)
      return parsed.value
    } catch (err: any) {
      if (err.code === "ENOENT") return null
      throw err
    }
  }

  async put(key: string, value: string, options?: any): Promise<void> {
    await fs.mkdir(KV_DIR, { recursive: true })
    const expiresAt =
      options?.expiration ? options.expiration * 1000 : undefined
    const payload = JSON.stringify({ value, expiresAt })
    await fs.writeFile(keyToPath(key), payload, "utf8")
    this.cache.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key)
    try {
      await fs.unlink(keyToPath(key))
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err
    }
  }

  async list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
    await fs.mkdir(KV_DIR, { recursive: true })
    const files = await fs.readdir(KV_DIR)
    const keys = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: decodeURIComponent(f.slice(0, -5)) }))
      .filter((k) => !options?.prefix || k.name.startsWith(options.prefix))
    return { keys }
  }
}
