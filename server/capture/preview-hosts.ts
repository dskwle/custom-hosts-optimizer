/**
 * 预览用的 hosts 注入（实现在容器内，不碰宿主机）。
 *
 * 背景：想「先验证再写规则」，就得让抓包浏览器按候选 IP 访问页面。
 * 一开始想用 CDP 的域名映射，但 Network.setHostMapping 并不是标准 CDP 命令
 * （实测报 `'Network.setHostMapping' wasn't found`），此路不通。
 *
 * 改成共享文件：
 *   chromium 容器把 /etc/hosts 绑定到宿主机的 data/preview-hosts
 *   app 容器本来就挂了 data 目录，于是写同一个文件即可
 *
 * 实测确认 Chrome 会实时读取该文件（写入 127.0.0.1 www.baidu.com 后，
 * 下一次抓包里该域名立刻出现失败，其它域名不受影响），不需要重启容器。
 * 这也是为什么值得走这条路：重启 chromium 会断开 noVNC 连接。
 *
 * 关键约束：文件必须保留 Docker 注入的基线行（localhost 等），
 * 否则容器内的本机解析会坏。所以注入内容放在带标记的区块里，
 * 只替换区块、不动其余行。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 与 docker-compose 里 chromium 的挂载点一致 */
function hostsFile(): string {
  return path.resolve(process.cwd(), 'data/preview-hosts')
}

const BEGIN = '# >>> custom-hosts preview (auto-generated, do not edit) >>>'
const END = '# <<< custom-hosts preview <<<'

/** 容器基线：绑定了 /etc/hosts 之后，Docker 不再注入这些行，得自己留着 */
const BASELINE = [
  '127.0.0.1\tlocalhost',
  '# The following lines are desirable for IPv6 capable hosts',
  '::1     localhost ip6-localhost ip6-loopback',
  'ff02::1 ip6-allnodes',
  'ff02::2 ip6-allrouters',
].join('\n')

/**
 * 确保文件存在且含基线。
 *
 * 为什么必须由 app 保证：如果宿主机上这个路径不存在，
 * Docker 会在启动容器时把它建成**目录**，chromium 的 /etc/hosts 就废了。
 * 所以部署脚本与运行期都要兜住。
 */
export async function ensureHostsFile(): Promise<void> {
  const file = hostsFile()
  try {
    const cur = await fs.readFile(file, 'utf8')
    if (!cur.trim()) throw new Error('empty')
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, BASELINE + '\n', 'utf8')
  }
}

/** 当前注入的映射（解析区块内容） */
export async function readInjected(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(hostsFile(), 'utf8')
    const m = raw.match(new RegExp(`${escapeRe(BEGIN)}([\\s\\S]*?)${escapeRe(END)}`))
    if (!m) return {}
    const out: Record<string, string> = {}
    for (const line of m[1].split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const [ip, host] = t.split(/\s+/)
      if (ip && host) out[host.toLowerCase()] = ip
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写入映射（整体替换区块）。传空对象等于清除。
 *
 * 用「先读→剥掉旧区块→追加新区块」而不是直接追加，
 * 是为了避免反复预览时区块层层累积。
 */
export async function writeInjected(mappings: Record<string, string>): Promise<void> {
  await ensureHostsFile()
  const file = hostsFile()
  const raw = await fs.readFile(file, 'utf8')

  // 剥掉已有区块（含可能的空行），保留其它内容
  const stripped = raw
    .replace(new RegExp(`\\n*${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n*`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')

  const entries = Object.entries(mappings)
    .map(([host, ip]) => [host.trim().toLowerCase(), ip.trim()] as const)
    .filter(([h, ip]) => h && ip && /^[a-z0-9.-]+$/.test(h) && /^[0-9a-fA-F:.]+$/.test(ip))

  let next = stripped.trimEnd()
  if (entries.length) {
    const block = [
      '',
      BEGIN,
      '# 预览映射：仅作用于抓包浏览器，系统 hosts 不受影响',
      ...entries.map(([h, ip]) => `${ip}\t${h}`),
      END,
    ].join('\n')
    next += block + '\n'
  } else {
    next += '\n'
  }

  await fs.writeFile(file, next, 'utf8')
}

/** 清除注入，恢复原状 */
export async function clearInjected(): Promise<void> {
  await writeInjected({})
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
