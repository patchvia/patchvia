import { createHash, randomBytes } from 'node:crypto'
import { isAtOrBelow, normalizeName, validateName, ValidationError } from '../dns/names.js'
import type { RTypeName } from '../dns/types.js'
import { ConflictError, NotFoundError, type ZoneService } from '../zones/zone-service.js'
import { parsePublishableIp, type IpFamily } from './ip.js'
import type { AuditRepository } from '../zones/audit-repository.js'
import type { DynDnsRepository, DynToken } from './dyndns.repository.js'

export const TOKEN_PREFIX = 'ddns_'
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export type UpdateOutcome =
  | { status: 'good' | 'nochg'; name: string; ip4?: string; ip6?: string }
  | { status: 'badauth' | 'nohost' | 'badip' | 'abuse' | 'conflict'; message: string }

const WRITES_PER_MINUTE = 6
const FAILURES_PER_MINUTE = 10

/**
 * Dynamic DNS: a per-name secret lets a router or script keep one A/AAAA record pointed at its current address. A
 * token can change that one name and nothing else, and an update that changes nothing writes nothing (so a client
 * polling every minute never bumps the serial, triggers NOTIFY, or fills the history).
 */
export class DynDnsService {
  private readonly writes = new Map<number, number[]>()
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly repo: DynDnsRepository,
    private readonly zones: ZoneService,
    private readonly now: () => number = Date.now,
    private readonly audit?: AuditRepository,
  ) {}

  list(zoneName: string): DynToken[] {
    return this.repo.list(this.zoneId(zoneName))
  }

  /** The secret is returned once and only its hash is kept. */
  create(zoneName: string, input: { name: string; ttl?: number }, actor = 'system'): DynToken & { token: string } {
    const zone = this.zones.getZone(zoneName)
    if (zone.kind === 'slave') throw new ValidationError('secondary zones cannot be updated dynamically')
    const name = normalizeName(input.name)
    validateName(name)
    if (!isAtOrBelow(name, zone.name)) throw new ValidationError(`${name} is outside ${zone.name}`)
    const ttl = input.ttl ?? 60
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new ValidationError('TTL must be between 1 second and 1 day')
    if (this.repo.list(zone.id).some((t) => t.name === name)) throw new ConflictError(`${name} already has a dynamic DNS token`)
    // A name that is already a CNAME or holds other data types is fine, but a CNAME can never coexist with A/AAAA
    if (this.zones.getRRset(zone.name, name, 'CNAME')) throw new ValidationError(`${name} is a CNAME, which cannot also hold an address`)
    const token = TOKEN_PREFIX + randomBytes(24).toString('base64url')
    const row = this.repo.insert({ zoneId: zone.id, name, ttl, prefix: token.slice(0, 10), hash: hashToken(token) })
    this.audit?.insert({ actor, zone: zone.name, action: 'dyndns.create', detail: { name, ttl } })
    return { ...row, token }
  }

  delete(zoneName: string, id: number, actor = 'system'): void {
    const t = this.repo.get(id)
    if (!t || t.zoneId !== this.zoneId(zoneName)) throw new NotFoundError(`token ${id} not found`)
    this.repo.delete(id)
    this.audit?.insert({ actor, zone: zoneName, action: 'dyndns.delete', detail: { name: t.name } })
  }

  setTtl(zoneName: string, id: number, ttl: number): DynToken {
    const t = this.repo.get(id)
    if (!t || t.zoneId !== this.zoneId(zoneName)) throw new NotFoundError(`token ${id} not found`)
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new ValidationError('TTL must be between 1 second and 1 day')
    this.repo.setTtl(id, ttl)
    return this.repo.get(id)!
  }

  /**
   * Applies an update. `candidates` are the addresses the client gave (or its own address); one A and one AAAA can be
   * set per call. `fromIp` identifies the caller for failure throttling only.
   */
  update(token: string | undefined, candidates: (string | undefined)[], fromIp: string, hostname?: string): UpdateOutcome {
    if (this.tooManyFailures(fromIp)) return { status: 'abuse', message: 'too many failed attempts' }
    const row = token ? this.repo.byHash(hashToken(token)) : undefined
    if (!row) {
      this.fail(fromIp)
      return { status: 'badauth', message: 'invalid token' }
    }
    if (hostname && normalizeName(hostname) !== row.name) return { status: 'nohost', message: `this token updates ${row.name}, not ${hostname}` }
    if (row.zoneKind === 'slave') return { status: 'conflict', message: 'the zone is now a secondary and cannot be updated' }

    const ips: Partial<Record<IpFamily, string>> = {}
    for (const c of candidates) {
      if (!c) continue
      const p = parsePublishableIp(c)
      if ('error' in p) {
        if (candidates.filter(Boolean).length === 1) return { status: 'badip', message: p.error }
        continue
      }
      ips[p.family] ??= p.ip
    }
    if (!ips[4] && !ips[6]) return { status: 'badip', message: 'no usable IP address' }

    const changes: { type: RTypeName; ip: string }[] = []
    for (const [family, ip] of [[4, ips[4]], [6, ips[6]]] as const) {
      if (!ip) continue
      const type: RTypeName = family === 4 ? 'A' : 'AAAA'
      const current = this.zones.getRRset(row.zoneName, row.name, type)
      const same = current && current.records.length === 1 && current.records[0]!.content === ip && current.ttl === row.ttl && !current.records[0]!.disabled
      if (!same) changes.push({ type, ip })
    }

    if (changes.length) {
      if (this.rateLimited(row.id)) return { status: 'abuse', message: `at most ${WRITES_PER_MINUTE} changes per minute` }
      try {
        this.zones.applyChanges(
          row.zoneName,
          changes.map((c) => ({ name: row.name, type: c.type, changetype: 'REPLACE' as const, ttl: row.ttl, records: [{ content: c.ip, disabled: false }] })),
          { actor: `dyndns:${row.name}` },
        )
      } catch (e) {
        return { status: 'conflict', message: (e as Error).message }
      }
    }
    this.repo.touch(row.id, { ip4: ips[4], ip6: ips[6] })
    return { status: changes.length ? 'good' : 'nochg', name: row.name, ip4: ips[4], ip6: ips[6] }
  }

  private zoneId(zoneName: string): number {
    return this.zones.getZone(zoneName).id
  }

  private rateLimited(id: number): boolean {
    const t = this.now()
    const recent = (this.writes.get(id) ?? []).filter((x) => t - x < 60_000)
    if (recent.length >= WRITES_PER_MINUTE) {
      this.writes.set(id, recent)
      return true
    }
    this.writes.set(id, [...recent, t])
    return false
  }

  private fail(ip: string): void {
    const t = this.now()
    this.failures.set(ip, [...(this.failures.get(ip) ?? []).filter((x) => t - x < 60_000), t])
  }

  private tooManyFailures(ip: string): boolean {
    const t = this.now()
    return (this.failures.get(ip) ?? []).filter((x) => t - x < 60_000).length >= FAILURES_PER_MINUTE
  }
}
