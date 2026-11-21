import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isResetError, isTimeoutError, judgeSni } from './sni-judge.ts'

test('TCP 不通 → tcp-blocked，不入清单', () => {
  const r = judgeSni({ tcpOk: false, withSniOk: false, controlOk: false })
  assert.equal(r.verdict, 'tcp-blocked')
  assert.equal(r.addToBlocklist, false)
})

test('真实 SNI 成功 → ok', () => {
  const r = judgeSni({ tcpOk: true, withSniOk: true, controlOk: false })
  assert.equal(r.verdict, 'ok')
  assert.equal(r.addToBlocklist, false)
})

test('握手超时 + 对照成功 → unknown，不加入排除清单（本次需求）', () => {
  const r = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: '握手超时',
    controlOk: true,
  })
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.addToBlocklist, false)
  assert.match(r.note, /超时/)
})

test('ETIMEDOUT 同样按超时处理', () => {
  const r = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: 'ETIMEDOUT',
    controlOk: true,
  })
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.addToBlocklist, false)
})

test('ECONNRESET + 对照成功 → 判定 SNI 阻断，入清单', () => {
  const r = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: 'ECONNRESET',
    controlOk: true,
  })
  assert.equal(r.verdict, 'sni-blocked')
  assert.equal(r.addToBlocklist, true)
})

test('EPROTO + 对照成功 → 判定 SNI 阻断', () => {
  const r = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: 'EPROTO',
    controlOk: true,
  })
  assert.equal(r.verdict, 'sni-blocked')
})

test('对照也失败 → unknown，无论真实 SNI 是什么原因', () => {
  for (const err of ['ECONNRESET', '握手超时', 'EPROTO']) {
    const r = judgeSni({
      tcpOk: true,
      withSniOk: false,
      withSniError: err,
      controlOk: false,
    })
    assert.equal(r.verdict, 'unknown', `${err} 应判 unknown`)
    assert.equal(r.addToBlocklist, false)
  }
})

test('非典型失败原因（如证书错误）→ unknown，证据不足不误封', () => {
  const r = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: 'CERT_HAS_EXPIRED',
    controlOk: true,
  })
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.addToBlocklist, false)
})

test('isTimeoutError 识别多种超时写法', () => {
  for (const s of ['握手超时', 'timeout', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'connect timeout']) {
    assert.equal(isTimeoutError(s), true, s)
  }
  for (const s of ['ECONNRESET', 'EPROTO', '', null, undefined]) {
    assert.equal(isTimeoutError(s as string), false, String(s))
  }
})

test('isResetError 只认主动断开类 errno', () => {
  assert.equal(isResetError('ECONNRESET'), true)
  assert.equal(isResetError('ECONNREFUSED'), true)
  assert.equal(isResetError('EPROTO'), true)
  assert.equal(isResetError('握手超时'), false)
  assert.equal(isResetError('ENOTFOUND'), false)
})

test('超时绝不能被误判为 reset（否则又会入清单）', () => {
  const timeout = judgeSni({
    tcpOk: true,
    withSniOk: false,
    withSniError: '握手超时',
    controlOk: true,
  })
  assert.notEqual(timeout.verdict, 'sni-blocked')
  assert.equal(timeout.addToBlocklist, false)
})
