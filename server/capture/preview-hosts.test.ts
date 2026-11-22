/**
 * 预览 hosts 注入单测。
 *
 * 这份文件会被 bind-mount 成 chromium 的 /etc/hosts，
 * 写坏了容器内的 DNS 就全废，所以重点验证：
 * 基线行必须保留、区块要能反复替换不累积、清除后不留垃圾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** 在临时目录里复现文件操作（模块路径依赖 cwd，这里注入一个等价实现做验证） */
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pvhosts-'))
  const file = path.join(dir, 'hosts')
  return { dir, file }
}

const BEGIN = '# >>> custom-hosts preview (auto-generated, do not edit) >>>'
const END = '# <<< custom-hosts preview <<<'

/** 与 preview-hosts.ts 同构的写入逻辑（便于在临时目录验证，不依赖 cwd） */
async function writeBlock(file: string, mappings: Record<string, string>) {
  const raw = await fs.readFile(file, 'utf8')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = raw
    .replace(new RegExp(`\\n*${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n*`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
  let next = stripped.trimEnd()
  const entries = Object.entries(mappings).filter(([h, ip]) => h && ip)
  if (entries.length) {
    next +=
      '\n' +
      [BEGIN, ...entries.map(([h, ip]) => `${ip}\t${h}`), END].join('\n') +
      '\n'
  } else {
    next += '\n'
  }
  await fs.writeFile(file, next, 'utf8')
}

const BASELINE = [
  '127.0.0.1\tlocalhost',
  '# The following lines are desirable for IPv6 capable hosts',
  '::1     localhost ip6-localhost ip6-loopback',
  'ff02::1 ip6-allnodes',
  'ff02::2 ip6-allrouters',
].join('\n')

test('注入后保留基线行（localhost 不能丢）', async () => {
  const { file } = await setup()
  await fs.writeFile(file, BASELINE + '\n', 'utf8')
  await writeBlock(file, { 'www.example.com': '1.2.3.4' })
  const out = await fs.readFile(file, 'utf8')
  assert.match(out, /127\.0\.0\.1\tlocalhost/)
  assert.match(out, /::1\s+localhost/)
  assert.match(out, /1\.2\.3\.4\twww\.example\.com/)
})

test('反复写入不累积区块', async () => {
  const { file } = await setup()
  await fs.writeFile(file, BASELINE + '\n', 'utf8')
  for (let i = 0; i < 5; i++) {
    await writeBlock(file, { 'a.com': `10.0.0.${i}` })
  }
  const out = await fs.readFile(file, 'utf8')
  assert.equal(out.split(BEGIN).length - 1, 1, '只应有一个起始标记')
  assert.match(out, /10\.0\.0\.4\ta\.com/)
  assert.doesNotMatch(out, /10\.0\.0\.0\ta\.com/, '旧值应被替换掉')
})

test('清除后不留下标记，基线仍在', async () => {
  const { file } = await setup()
  await fs.writeFile(file, BASELINE + '\n', 'utf8')
  await writeBlock(file, { 'a.com': '1.1.1.1' })
  await writeBlock(file, {})
  const out = await fs.readFile(file, 'utf8')
  assert.doesNotMatch(out, /custom-hosts preview/)
  assert.match(out, /127\.0\.0\.1\tlocalhost/)
  assert.doesNotMatch(out, /1\.1\.1\.1/)
})

test('多域名一次写入', async () => {
  const { file } = await setup()
  await fs.writeFile(file, BASELINE + '\n', 'utf8')
  await writeBlock(file, { 'a.com': '1.1.1.1', 'b.com': '2.2.2.2', 'c.com': '::1' })
  const out = await fs.readFile(file, 'utf8')
  for (const [h, ip] of [['a.com', '1.1.1.1'], ['b.com', '2.2.2.2'], ['c.com', '::1']] as const) {
    assert.match(out, new RegExp(`${ip.replace(/:/g, ':')}\\t${h.replace(/\./g, '\\.')}`))
  }
})
