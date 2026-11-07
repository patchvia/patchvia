import dgram from 'node:dgram'
import net from 'node:net'
import { handleMessages, type HandlerContext } from './handler.js'
import type { ZoneLookup } from './resolver.js'

export interface Listener {
  close(): Promise<void>
  port: number
}

function socketType(host: string): 'udp4' | 'udp6' {
  return net.isIPv4(host) ? 'udp4' : 'udp6'
}

export function listenUdp(zones: ZoneLookup, host: string, port: number, ctx?: HandlerContext): Promise<Listener> {
  const socket = dgram.createSocket({ type: socketType(host), ipv6Only: false })
  socket.on('message', (msg, rinfo) => {
    const [out] = handleMessages(zones, msg, 'udp', rinfo.address, ctx)
    if (out) socket.send(out, rinfo.port, rinfo.address)
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, host, () => {
      socket.removeListener('error', reject)
      socket.on('error', (err) => console.error('udp error', err))
      resolve({
        port: socket.address().port,
        close: () => new Promise((r) => socket.close(() => r())),
      })
    })
  })
}

const TCP_IDLE_MS = 10_000

export function listenTcp(zones: ZoneLookup, host: string, port: number, ctx?: HandlerContext): Promise<Listener> {
  const sockets = new Set<net.Socket>()
  const perIp = new Map<string, number>()
  const server = net.createServer((sock) => {
    const ip = sock.remoteAddress ?? ''
    const limit = ctx?.maxTcpPerIp ?? 0
    if (limit > 0 && (perIp.get(ip) ?? 0) >= limit) {
      // One address holding hundreds of connections open is exhausting us, not asking questions
      sock.destroy()
      return
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    sock.once('close', () => {
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
    })
    sockets.add(sock)
    sock.setTimeout(TCP_IDLE_MS, () => sock.destroy())
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sock.destroy())
    let pending = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      // Messages are framed by a 2-byte length; a connection may carry several
      while (pending.length >= 2) {
        const len = pending.readUInt16BE(0)
        if (pending.length < 2 + len) return
        const msg = pending.subarray(2, 2 + len)
        pending = pending.subarray(2 + len)
        const out = handleMessages(zones, Buffer.from(msg), 'tcp', sock.remoteAddress, ctx)
        if (out.length === 0) {
          sock.destroy()
          return
        }
        // A zone transfer is several messages, each with its own 2-byte length
        sock.write(Buffer.concat(out.flatMap((m) => [Buffer.from([m.length >> 8, m.length & 0xff]), m])))
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, ipv6Only: false }, () => {
      server.removeListener('error', reject)
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}
