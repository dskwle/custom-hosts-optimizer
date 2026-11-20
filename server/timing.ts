/**
 * 真实延迟测量：把一次 HTTPS 请求拆成可分别计时的阶段。
 *
 * 为什么只有本地能这么做：
 *   Workers 的 connect() 只给 TCP 层，拿不到 TLS 握手耗时；
 *   浏览器侧跨域又读不到 PerformanceResourceTiming 的细分字段。
 *   本地用 node:tls + node:http 可以精确测量每一段。
 *
 * 四个阶段：
 *   dns   - 域名解析
 *   tcp   - TCP 三次握手
 *   tls   - TLS 握手（含证书校验）
 *   ttfb  - 发出请求到收到响应首字节
 *
 * 对 hosts 场景而言 tls + ttfb 比单纯 tcp 更有参考价值——
 * 因为「能连上」不代表「能正常握手取到数据」。
 */
import dns from "node:dns/promises"
import net from "node:net"
import tls from "node:tls"

export interface TimingResult {
  domain: string
  ip: string | null
  ok: boolean
  dnsMs: number | null
  tcpMs: number | null
  tlsMs: number | null
  ttfbMs: number | null
  /** tcp + tls + ttfb，反映「用户感知到首屏数据」的耗时 */
  totalMs: number | null
  httpStatus: number | null
  error?: string
}

interface TlsOptions {
  host: string
  ip?: string
  port?: number
  path?: string
  timeoutMs?: number
}

/** 对指定 IP（或域名）做完整分层计时 */
export function measureTiming(opts: TlsOptions): Promise<TimingResult> {
  const { host, ip, port = 443, path: reqPath = "/", timeoutMs = 8000 } = opts
  const result: TimingResult = {
    domain: host,
    ip: ip ?? null,
    ok: false,
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    ttfbMs: null,
    totalMs: null,
    httpStatus: null,
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (error?: string) => {
      if (settled) return
      settled = true
      if (error) result.error = error
      if (result.tcpMs != null) {
        result.totalMs =
          (result.tcpMs ?? 0) + (result.tlsMs ?? 0) + (result.ttfbMs ?? 0)
      }
      resolve(result)
    }

    const overall = setTimeout(() => {
      socket?.destroy()
      finish("timeout")
    }, timeoutMs)

    const t0 = Date.now()
    let tConnect = 0
    let tSecure = 0

    // 指定 IP 时跳过 DNS；否则让 node 自己解析
    const socket = tls.connect(
      {
        host: ip || host,
        port,
        servername: host, // SNI 必须是真实域名，否则证书校验会失败
        rejectUnauthorized: false, // 只为测速，不校验证书有效性
        ALPNProtocols: ["http/1.1"],
      },
      () => {
        // TLS 握手完成
        tSecure = Date.now()
        result.tcpMs = tConnect - t0
        result.tlsMs = tSecure - tConnect

        // 发一个最小化的 HTTP/1.1 GET，测首字节
        const path2 = reqPath
        socket.write(
          `GET ${path2} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            `User-Agent: custom-hosts-local/1.0\r\n` +
            `Accept: */*\r\n` +
            `Connection: close\r\n\r\n`
        )

        socket.once("data", (buf) => {
          result.ttfbMs = Date.now() - tSecure
          const firstLine = buf.toString("utf8", 0, Math.min(buf.length, 64))
          const m = firstLine.match(/^HTTP\/\d\.\d (\d{3})/)
          result.httpStatus = m ? Number(m[1]) : null
          result.ok = result.httpStatus !== null && result.httpStatus < 500
          clearTimeout(overall)
          socket.destroy()
          finish()
        })
      }
    )

    socket.once("connect", () => {
      // TLS socket 的 connect 事件在 TCP 层完成时触发
      tConnect = Date.now()
    })

    socket.once("error", (err) => {
      clearTimeout(overall)
      // 区分是 TCP 阶段失败还是 TLS 阶段失败
      if (tConnect === 0) {
        finish(`tcp: ${(err as Error).message}`)
      } else {
        result.tcpMs = tConnect - t0
        finish(`tls: ${(err as Error).message}`)
      }
    })

    socket.once("close", () => {
      clearTimeout(overall)
      finish(result.ok ? undefined : result.error || "closed before response")
    })
  })
}

/** 先解析出 IP，再对该 IP 做完整计时 */
/**
 * 先解析出 IP，再对该 IP 做完整计时。
 *
 * skipDns：调用方已有 IP 时跳过解析，dnsMs 置 null。
 *          既然 IP 是外部给定的，再解析一次毫无意义。
 */
export async function resolveAndMeasure(
  domain: string,
  ip?: string,
  options: { skipDns?: boolean } = {}
): Promise<TimingResult> {
  let targetIp = ip
  let dnsMs: number | null = null

  if (!targetIp) {
    const t = Date.now()
    try {
      const ips = await dns.resolve4(domain)
      dnsMs = Date.now() - t
      targetIp = ips[0]
    } catch (err) {
      return {
        domain,
        ip: null,
        ok: false,
        dnsMs: null,
        tcpMs: null,
        tlsMs: null,
        ttfbMs: null,
        totalMs: null,
        httpStatus: null,
        error: `dns: ${(err as Error).message}`,
      }
    }
  } else if (options.skipDns) {
    // 指定了 IP 就是不想再查 DNS
    dnsMs = null
  }

  const r = await measureTiming({ host: domain, ip: targetIp })
  return { ...r, dnsMs }
}

/** 纯 TCP 握手测速，用于大量候选 IP 的初筛（比完整计时快得多） */
export function measureTcpOnly(
  ip: string,
  port = 443,
  timeoutMs = 2500
): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()
    let settled = false
    const done = (v: number | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(Date.now() - start))
    socket.once("timeout", () => done(null))
    socket.once("error", () => done(null))
    socket.connect(port, ip)
  })
}
