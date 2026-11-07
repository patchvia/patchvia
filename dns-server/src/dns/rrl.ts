import { isIPv4 } from 'node:net'
import { normalizeIp } from '../common/cidr.js'
import { ipv6ToBuffer } from './rdata.js'

export type RrlDecision = 'allow' | 'drop' | 'truncate'

export interface RrlOptions {
  /** Identical responses allowed per second to one client network. 0 disables limiting. */
  responsesPerSecond: number
  /** Of the responses over the limit, every Nth is sent truncated (so a real client retries over TCP) and the rest are dropped. 0 drops all. */
  slip: number
  /** Clients that are never limited (monitoring, your own resolvers) */
  exempt?: (addr: string | undefined) => boolean
  now?: () => number
  maxEntries?: number
}

interface Bucket {
  tokens: number
  last: number
  over: number
}

/** The network a client counts as: /24 for IPv4, /56 for IPv6 (what RFC 8906 and BIND's RRL use). */
export function clientPrefix(addr: string): string {
  const ip = normalizeIp(addr)
  if (isIPv4(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24'
  try {
    const b = ipv6ToBuffer(ip)
    return [...b.subarray(0, 7)].map((x) => x.toString(16).padStart(2, '0')).join('') + '/56'
  } catch {
    return ip
  }
}

/**
 * Response rate limiting for UDP. UDP answers can be spoofed to a victim's address, so an authoritative server that
 * answers the same question without limit becomes a DDoS amplifier. Each (client network, response) pair gets a
 * token bucket; past the limit most responses are dropped and some are truncated, which costs a legitimate resolver
 * one TCP retry and costs a spoofed victim nothing.
 */
export class ResponseRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  private readonly max: number
  readonly stats = { dropped: 0, truncated: 0 }

  constructor(private readonly opts: RrlOptions) {
    this.now = opts.now ?? Date.now
    this.max = opts.maxEntries ?? 200_000
  }

  get enabled(): boolean {
    return this.opts.responsesPerSecond > 0
  }

  check(remote: string | undefined, responseKey: string): RrlDecision {
    if (!this.enabled || !remote || this.opts.exempt?.(remote)) return 'allow'
    const rate = this.opts.responsesPerSecond
    const key = `${clientPrefix(remote)}|${responseKey}`
    const t = this.now()
    let b = this.buckets.get(key)
    if (!b) {
      if (this.buckets.size >= this.max) this.evict(t)
      b = { tokens: rate, last: t, over: 0 }
      this.buckets.set(key, b)
    } else {
      b.tokens = Math.min(rate, b.tokens + ((t - b.last) / 1000) * rate)
      b.last = t
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      b.over = 0
      return 'allow'
    }
    b.over++
    const slip = this.opts.slip
    if (slip > 0 && b.over % slip === 0) {
      this.stats.truncated++
      return 'truncate'
    }
    this.stats.dropped++
    return 'drop'
  }

  /** Drops idle buckets first; if still full, the oldest. Keeps memory bounded under a spoofed-source flood. */
  private evict(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.last > 2000) this.buckets.delete(k)
    if (this.buckets.size < this.max) return
    let n = Math.ceil(this.max / 10)
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k)
      if (--n <= 0) break
    }
  }

  get size(): number {
    return this.buckets.size
  }
}
