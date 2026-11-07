import { isIPv4, isIPv6 } from 'node:net'
import { ipv4ToBuffer, ipv6ToBuffer } from '../dns/rdata.js'

interface Rule {
  family: 4 | 6
  net: bigint
  bits: number
}

const toBig = (b: Buffer) => b.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n)

/** Strips an IPv6 zone id and unwraps IPv4-mapped addresses (::ffff:1.2.3.4), which dual-stack sockets report. */
export function normalizeIp(addr: string): string {
  const a = addr.split('%')[0]!.toLowerCase()
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  return m ? m[1]! : a
}

function parseEntry(entry: string): Rule {
  const [ip, prefix, ...rest] = entry.trim().split('/')
  if (!ip || rest.length) throw new Error(`invalid address or network: "${entry}"`)
  const family = isIPv4(ip) ? 4 : isIPv6(ip) ? 6 : 0
  if (!family) throw new Error(`invalid address or network: "${entry}"`)
  const max = family === 4 ? 32 : 128
  const bits = prefix === undefined ? max : Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (prefix !== undefined && !/^\d+$/.test(prefix))) {
    throw new Error(`invalid prefix length in "${entry}"`)
  }
  const value = toBig(family === 4 ? ipv4ToBuffer(ip) : ipv6ToBuffer(ip))
  const shift = BigInt(max - bits)
  return { family, net: (value >> shift) << shift, bits }
}

/** Compiles a list like ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"] into a matcher. Throws on invalid entries. */
export function compileAcl(entries: string[]): (addr: string | undefined) => boolean {
  const rules = entries.map(parseEntry)
  return (addr) => {
    if (!addr || rules.length === 0) return false
    const ip = normalizeIp(addr)
    const family = isIPv4(ip) ? 4 : isIPv6(ip) ? 6 : 0
    if (!family) return false
    const max = family === 4 ? 32 : 128
    const value = toBig(family === 4 ? ipv4ToBuffer(ip) : ipv6ToBuffer(ip))
    return rules.some((r) => {
      if (r.family !== family) return false
      const shift = BigInt(max - r.bits)
      return (value >> shift) << shift === r.net
    })
  }
}
