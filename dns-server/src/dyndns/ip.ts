import { isIPv4, isIPv6 } from 'node:net'
import { normalizeIp } from '../common/cidr.js'
import { ipv6ToBuffer } from '../dns/rdata.js'

export type IpFamily = 4 | 6

export interface ParsedIp {
  ip: string
  family: IpFamily
}

/**
 * A client address worth publishing: valid, and not one that can never be reached (unspecified, multicast, broadcast,
 * loopback, link-local). Private LAN addresses are allowed: dynamic DNS is also used inside networks.
 */
export function parsePublishableIp(input: string | undefined): ParsedIp | { error: string } {
  if (!input) return { error: 'no address' }
  const ip = normalizeIp(input.trim())
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return { error: `${ip} is not a routable address` }
    return { ip, family: 4 }
  }
  if (isIPv6(ip)) {
    const buf = ipv6ToBuffer(ip)
    const allZero = buf.every((x) => x === 0)
    const loopback = buf.subarray(0, 15).every((x) => x === 0) && buf[15] === 1
    if (allZero || loopback || buf[0] === 0xff || (buf[0] === 0xfe && (buf[1]! & 0xc0) === 0x80)) return { error: `${ip} is not a routable address` }
    return { ip, family: 6 }
  }
  return { error: `"${input}" is not an IP address` }
}
