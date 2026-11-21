/**
 * 提取 public/console.html 里的内联脚本做语法检查。
 *
 * 为什么不直接 node --check console.html：它不是 JS。
 * 控制台是单文件应用，脚本写错只会在浏览器里白屏，构建阶段发现不了，
 * 所以在门禁里单独拦一道。
 */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'

const run = promisify(execFile)

const html = await readFile(new URL('../public/console.html', import.meta.url), 'utf8')
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

if (blocks.length === 0) {
  console.error('未找到内联 <script> 块，检查是否改坏了标签')
  process.exit(1)
}

let failed = false
for (const [i, code] of blocks.entries()) {
  const file = path.join(tmpdir(), `chs-console-js-${i}.js`)
  await (await import('node:fs/promises')).writeFile(file, code, 'utf8')
  try {
    await run(process.execPath, ['--check', file])
    console.log(`script[${i}] 语法 OK（${code.split('\n').length} 行）`)
  } catch (e) {
    failed = true
    console.error(`script[${i}] 语法错误：`)
    console.error(String(e.stderr || e.message).split('\n').slice(0, 12).join('\n'))
  }
}

process.exit(failed ? 1 : 0)
