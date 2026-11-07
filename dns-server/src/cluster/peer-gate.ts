import dns from 'node:dns/promises'
import { isIP } from 'node:net'
import { Logger } from '@nestjs/common'
import { compileAcl, normalizeIp } from '../common/cidr.js'
import { EnvelopeError, open, seal } from './envelope.js'
import type { PeerAddress } from './peer-address.js'

/**
 * Decides who may use the cluster endpoints: the request must come from a peer's address (or an explicitly allowed
 * network) AND carry a message sealed with the cluster secret. Either alone is not enough.
 */
export class PeerGate {
  private readonly log = new Logger('Cluster')
  private resolved = new Set<string>()
  private readonly extra: (addr: string | undefined) => boolean
  private timer?: NodeJS.Timeout

  constructor(
    private readonly secret: string,
    private readonly peers: PeerAddress[],
    allowFrom: string[],
    private readonly lookup: (host: string) => Promise<string[]> = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
  ) {
    this.extra = compileAcl(allowFrom)
    for (const p of peers) if (isIP(p.host)) this.resolved.add(normalizeIp(p.host))
  }

  /** Finds the current addresses of the peers' hostnames, now and every minute (addresses change). */
  async start(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => void this.refresh(), 60_000)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    const next = new Set<string>()
    for (const p of this.peers) {
      if (isIP(p.host)) {
        next.add(normalizeIp(p.host))
        continue
      }
      try {
        for (const a of await this.lookup(p.host)) next.add(normalizeIp(a))
      } catch (e) {
        this.log.warn(`cannot resolve peer ${p.host}: ${(e as Error).message}`)
        // keep what we knew about this peer rather than lock it out because DNS hiccupped
        for (const old of this.resolved) next.add(old)
      }
    }
    this.resolved = next
  }

  allowed(remote: string | undefined): boolean {
    if (!remote) return false
    return this.resolved.has(normalizeIp(remote)) || this.extra(remote)
  }

  get addresses(): string[] {
    return [...this.resolved].sort()
  }

  /** Opens a request. The same vague failure for a stranger, a wrong secret and a stale message. */
  openRequest<T>(remote: string | undefined, route: string, token: unknown): T {
    if (!this.allowed(remote)) {
      this.log.warn(`refused cluster request from ${remote ?? 'unknown'}: not a configured peer address`)
      throw new EnvelopeError('invalid cluster message')
    }
    if (typeof token !== 'string') throw new EnvelopeError('invalid cluster message')
    try {
      return open<T>(this.secret, `cluster.${route}.req`, token)
    } catch (e) {
      this.log.warn(`refused cluster request from ${remote}: message did not verify (wrong secret?)`)
      throw e
    }
  }

  sealResponse(route: string, payload: object): string {
    return seal(this.secret, `cluster.${route}.res`, payload)
  }
}
