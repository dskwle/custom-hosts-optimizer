/**
 * cloudflare:sockets 的 Node 实现（仅本地分支使用）。
 *
 * 原 src/services/hosts.ts 里 `import { connect } from "cloudflare:sockets"`
 * 用于测 TCP 握手延迟；这个模块只存在于 Workers 运行时，Node 里没有。
 *
 * 这里用 node:net 提供等价的 connect()，返回形状与 Workers 的 Socket 一致
 * （至少包含 opened 这个 Promise 和 close()），
 * 这样 src/ 的业务代码无需任何改动即可在本地运行。
 * 本地分支的完整探测走 server/probe.ts，这里只是为了让旧代码能加载。
 */
import net from "node:net"

interface SocketLike {
  opened: Promise<unknown>
  closed: Promise<unknown>
  close(): Promise<void>
  writable: WritableStream
  readable: ReadableStream
}

export function connect(
  address: { hostname: string; port: number },
  _options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean }
): SocketLike {
  const socket = new net.Socket()

  const opened = new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.once("error", onError)
    socket.once("connect", () => {
      socket.off("error", onError)
      resolve()
    })
    socket.connect(address.port, address.hostname)
  })

  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
  })

  return {
    opened,
    closed,
    close: async () => {
      socket.destroy()
    },
    writable: new WritableStream(),
    readable: new ReadableStream(),
  }
}

export default { connect }
