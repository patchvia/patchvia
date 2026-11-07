import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import net from 'node:net'
import { decodeMessage, type DecodedRR } from '../dns/decode.js'
import { encodeQuery } from '../dns/codec.js'
import { isAtOrBelow } from '../dns/names.js'
import { RCode, RType, typeName } from '../dns/types.js'
import type { RRsetInput } from '../zones/zone.js'
import type { Target } from './target.js'

export interface TransferData {
  serial: number
  rrsets: RRsetInput[]
  /** Records we could not take: unsupported types (by name), plus "out-of-zone" */
  skipped: Record<string, number>
}

/** Everything the replication code needs from the network. Tests replace it. */
export interface ReplicationIO {
  soaSerial(target: Target, zone: string): Promise<number>
  axfr(target: Target, zone: string): Promise<TransferData>
  sendNotify(target: Target, packet: Buffer, timeoutMs: number): Promise<Buffer | null>
}

const OTHER_TYPES: Record<number, string> = {
  35: 'NAPTR', 43: 'DS', 44: 'SSHFP', 46: 'RRSIG', 47: 'NSEC', 48: 'DNSKEY', 50: 'NSEC3', 51: 'NSEC3PARAM', 52: 'TLSA', 64: 'SVCB', 65: 'HTTPS',
}
const describeType = (n: number) => typeName(n) ?? OTHER_TYPES[n] ?? `TYPE${n}`

const RCODE_NAMES = Object.fromEntries(Object.entries(RCode).map(([k, v]) => [v, k])) as Record<number, string>
function rcodeError(rcode: number, target: Target): Error {
  const name = RCODE_NAMES[rcode] ?? `rcode ${rcode}`
  return new Error(
    rcode === RCode.REFUSED || rcode === RCode.NOTAUTH
      ? `${target.host} refused (${name}); it must allow transfers to this server`
      : `${target.host} answered ${name}`,
  )
}

const frame = (b: Buffer) => Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b])

/** Sends one request over TCP and feeds each length-framed reply to `onMessage` until it returns true. */
function tcpStream(target: Target, request: Buffer, onMessage: (msg: Buffer) => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: target.host, port: target.port })
    let buf = Buffer.alloc(0)
    let finished = false
    const done = (err?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      sock.destroy()
      err ? reject(err) : resolve()
    }
    const timer = setTimeout(() => done(new Error(`timed out talking to ${target.host}:${target.port}`)), timeoutMs)
    sock.on('connect', () => sock.write(frame(request)))
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0)
        if (buf.length < 2 + len) return
        const msg = buf.subarray(2, 2 + len)
        buf = buf.subarray(2 + len)
        try {
          if (onMessage(msg)) return done()
        } catch (e) {
          return done(e as Error)
        }
      }
    })
    sock.on('error', (e) => done(e))
    sock.on('close', () => done(new Error('connection closed before the transfer completed')))
  })
}

const serialOf = (soa: DecodedRR) => Number(soa.content?.split(' ')[2])

const MAX_RECORDS = 1_000_000

export const realIO: ReplicationIO = {
  async soaSerial(target, zone) {
    const id = Math.floor(Math.random() * 65536)
    let serial: number | undefined
    await tcpStream(
      target,
      encodeQuery(id, zone, RType.SOA),
      (msg) => {
        const m = decodeMessage(msg)
        if (m.id !== id) throw new Error('mismatched reply')
        if (m.rcode !== RCode.NOERROR) throw rcodeError(m.rcode, target)
        const soa = m.answers.find((a) => a.type === RType.SOA)
        if (!soa) throw new Error(`${target.host} has no SOA for ${zone}`)
        serial = serialOf(soa)
        return true
      },
      10_000,
    )
    return serial!
  },

  async axfr(target, zone) {
    const id = Math.floor(Math.random() * 65536)
    const skipped: Record<string, number> = {}
    const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1)
    const sets = new Map<string, RRsetInput>()
    let serial = NaN
    let first = true
    let count = 0

    await tcpStream(
      target,
      encodeQuery(id, zone, RType.AXFR),
      (msg) => {
        const m = decodeMessage(msg)
        if (m.id !== id) throw new Error('mismatched reply')
        if (m.rcode !== RCode.NOERROR) throw rcodeError(m.rcode, target)
        for (const rr of m.answers) {
          if (first) {
            if (rr.type !== RType.SOA) throw new Error(`${target.host} did not start the transfer with an SOA`)
            serial = serialOf(rr)
            first = false
          } else if (rr.type === RType.SOA) {
            if (rr.name === zone) return true // closing SOA
          }
          if (++count > MAX_RECORDS) throw new Error(`transfer exceeds ${MAX_RECORDS} records`)
          if (!isAtOrBelow(rr.name, zone)) {
            skip('out-of-zone')
            continue
          }
          const type = typeName(rr.type)
          if (!type || rr.content === null) {
            skip(describeType(rr.type))
            continue
          }
          const key = `${rr.name}|${type}`
          const set = sets.get(key)
          if (!set) sets.set(key, { name: rr.name, type, ttl: rr.ttl, contents: [rr.content] })
          else {
            set.ttl = Math.min(set.ttl, rr.ttl) // an RRset has one TTL (RFC 2181 5.2)
            if (!set.contents.includes(rr.content)) set.contents.push(rr.content)
          }
        }
        return false
      },
      5 * 60_000,
    )
    return { serial, rrsets: [...sets.values()], skipped }
  },

  async sendNotify(target, packet, timeoutMs) {
    const { address, family } = await dns.lookup(target.host)
    return new Promise((resolve) => {
      const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4')
      const timer = setTimeout(() => finish(null), timeoutMs)
      const finish = (reply: Buffer | null) => {
        clearTimeout(timer)
        sock.close()
        resolve(reply)
      }
      sock.once('message', (m) => finish(m))
      sock.once('error', () => finish(null))
      sock.send(packet, target.port, address, (err) => err && finish(null))
    })
  },
}
