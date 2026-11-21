// 会话落盘的删除语义：这几个函数直接动文件，出错会造成"点了清理但文件还在"，
// 而用户看到的是列表已刷新、以为删掉了。用临时目录跑真实文件系统。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearStoredSessions, deleteSession, listStoredSessions, saveSession } from './store.ts'
import type { CaptureSession } from './types.ts'

function session(id: string, startedAt = '2026-11-21T03:00:00.000Z'): CaptureSession {
  return {
    id,
    url: 'https://example.com/',
    status: 'stopped',
    startedAt,
    endedAt: startedAt,
    requestCount: 1,
    hostCount: 1,
  }
}

/** store 用 process.cwd()/data/capture，测试里切到临时目录再切回来 */
async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const prev = process.cwd()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-store-'))
  process.chdir(dir)
  try {
    await fn()
  } finally {
    process.chdir(prev)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('删除已存在的会话：文件消失，再读为 null', async () => {
  await withTempCwd(async () => {
    const s = session('capture-test-1')
    await saveSession({ session: s, requests: [] })
    assert.equal((await listStoredSessions()).length, 1)

    assert.equal(await deleteSession(s.id), true)
    assert.equal((await listStoredSessions()).length, 0)
  })
})

test('删除不存在的会话返回 false，不抛错', async () => {
  await withTempCwd(async () => {
    assert.equal(await deleteSession('capture-not-exist'), false)
  })
})

test('非法 id 不会碰到文件系统', async () => {
  await withTempCwd(async () => {
    assert.equal(await deleteSession('../../etc/passwd'), false)
    assert.equal(await deleteSession(''), false)
  })
})

test('清空时保留 except 里的会话', async () => {
  await withTempCwd(async () => {
    await saveSession({ session: session('capture-keep-1'), requests: [] })
    await saveSession({ session: session('capture-drop-1', '2026-11-21T02:00:00.000Z'), requests: [] })
    await saveSession({ session: session('capture-drop-2', '2026-11-21T01:00:00.000Z'), requests: [] })

    const removed = await clearStoredSessions(new Set(['capture-keep-1']))
    assert.equal(removed, 2)

    const left = await listStoredSessions()
    assert.deepEqual(left.map((s) => s.id), ['capture-keep-1'])
  })
})

test('清空也会删掉读不出来的损坏文件', async () => {
  await withTempCwd(async () => {
    await saveSession({ session: session('capture-ok-1'), requests: [] })
    // 手工写一个坏 JSON：列表接口会跳过它，但"清空全部"应该照样清掉
    await fs.writeFile(path.join(process.cwd(), 'data/capture/capture-broken-1.json'), '{ not json', 'utf8')

    const removed = await clearStoredSessions()
    assert.equal(removed, 2)
    assert.equal((await listStoredSessions()).length, 0)
  })
})
