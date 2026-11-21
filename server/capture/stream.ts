/**
 * 抓包实时推送（SSE 扇出）。
 *
 * 设计成"发布-订阅"而不是"每个连接自己轮询会话"：
 * 一个 session 可能同时被浏览器多个标签页、或用户重连后遗留的旧连接订阅，
 * 采集侧只应该 publish 一次，由 hub 复制给所有 sink。
 *
 * 断线重连语义（契约 §3）：**只推增量，不重放历史**。
 * 新连接进来时由路由层先补一帧当前 `state`，历史明细让前端去调 /summary 与 /:id 补全——
 * 一次抓包可能有上千条请求，重放会让重连变慢、也让前端出现重复行。
 */

import type { CaptureSession, CapturedRequest } from './types.ts'

export type CaptureFrame =
  | { type: 'state'; session: CaptureSession }
  | { type: 'request'; request: CapturedRequest }
  | { type: 'error'; message: string }
  | { type: 'end'; sessionId: string }

/** 一个 SSE 连接的写入口；实现方负责把帧序列化成 `data: ...` */
export type FrameSink = (frame: CaptureFrame) => void

export class CaptureStreamHub {
  private subs = new Map<string, Set<FrameSink>>()

  /** 订阅指定会话；返回取消订阅函数（连接关闭时必须调用，否则会一直往死连接写） */
  subscribe(sessionId: string, sink: FrameSink): () => void {
    let set = this.subs.get(sessionId)
    if (!set) {
      set = new Set()
      this.subs.set(sessionId, set)
    }
    set.add(sink)

    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.subs.get(sessionId)
      if (!current) return
      current.delete(sink)
      if (current.size === 0) this.subs.delete(sessionId)
    }
  }

  /**
   * 广播一帧。单个 sink 抛异常（连接已断、背压写失败）不能影响其它订阅者，
   * 否则一个挂掉的浏览器标签页会让整场抓包丢帧。
   */
  publish(sessionId: string, frame: CaptureFrame): void {
    const set = this.subs.get(sessionId)
    if (!set) return
    for (const sink of [...set]) {
      try {
        sink(frame)
      } catch (err) {
        console.error('[capture] 推送失败，丢弃该订阅', err instanceof Error ? err.message : err)
        set.delete(sink)
      }
    }
    if (set.size === 0) this.subs.delete(sessionId)
  }

  subscriberCount(sessionId: string): number {
    return this.subs.get(sessionId)?.size ?? 0
  }
}
