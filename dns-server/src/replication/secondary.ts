import dns from 'node:dns/promises'
import { Logger } from '@nestjs/common'
import { normalizeIp } from '../common/cidr.js'
import { RCode } from '../dns/types.js'
import { serialGt } from '../zones/serial.js'
import type { ZoneIndex } from '../zones/zone-index.js'
import type { ZoneRepository } from '../zones/zone-repository.js'
import type { ZoneService } from '../zones/zone-service.js'
import { isIPLiteral } from './ip.js'
import type { ReplicationIO } from './io.js'
import { parseTarget, type Target } from './target.js'

export interface TransferResult {
  /** False when the primary had nothing newer */
  updated: boolean
  serial: number
  records: number
  skipped: Record<string, number>
}

const MIN_WAIT_S = 30
const MAX_WAIT_S = 86_400

/** Refresh/retry intervals come from the zone's own SOA, within sane bounds. */
export function nextDelaySeconds(soaContent: string | undefined, ok: boolean): number {
  const p = soaContent?.trim().split(/\s+/)
  const refresh = Number(p?.[3])
  const retry = Number(p?.[4])
  const pick = ok ? refresh : retry
  const fallback = ok ? 3600 : 120
  const v = Number.isFinite(pick) && pick > 0 ? pick : fallback
  return Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, v))
}

/** Keeps secondary zones in sync with their primaries: periodic refresh, NOTIFY-triggered refresh, manual retrieve. */
export class SecondaryManager {
  private readonly log = new Logger('Secondary')
  private readonly nextAt = new Map<string, number>()
  private readonly running = new Map<string, Promise<TransferResult>>()
  /** Addresses each zone's primaries resolved to at their last contact, to authenticate incoming NOTIFYs */
  private readonly masterIps = new Map<string, Set<string>>()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly repo: ZoneRepository,
    private readonly zones: ZoneService,
    private readonly index: ZoneIndex,
    private readonly io: ReplicationIO,
    private readonly now: () => number = Date.now,
  ) {}

  start(tickMs = 15_000): void {
    this.stop()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), tickMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Checks every secondary zone that is due. Exposed for tests. */
  async tick(): Promise<void> {
    const due = this.repo
      .listZones()
      .filter((z) => z.kind === 'slave' && (this.nextAt.get(z.name) ?? 0) <= this.now())
      .map((z) => z.name)
    await Promise.all(due.map((name) => this.check(name).catch(() => undefined)))
  }

  /** Asks the primary whether it has a newer serial and transfers only if it does. */
  check(zone: string): Promise<TransferResult> {
    return this.run(zone, false)
  }

  /** Transfers now regardless of serials (the "retrieve" button). */
  retrieve(zone: string): Promise<TransferResult> {
    return this.run(zone, true)
  }

  /** Called when a secondary zone is created or its primaries change. */
  refreshSoon(zone: string): void {
    this.nextAt.delete(zone)
    void this.run(zone, true).catch(() => undefined)
  }

  /** Incoming NOTIFY: accept only for a secondary zone, only from one of its primaries. */
  handleNotify(zone: string, remote: string | undefined): number {
    const row = this.repo.getZone(zone)
    if (!row || row.kind !== 'slave') return RCode.NOTAUTH
    const ip = remote ? normalizeIp(remote) : undefined
    const known = this.masterIps.get(zone)
    const literals = row.masters.map((m) => parseTarget(m).host).filter(isIPLiteral)
    if (!ip || !(literals.includes(ip) || known?.has(ip))) return RCode.REFUSED
    this.nextAt.delete(zone)
    void this.check(zone).catch(() => undefined)
    return RCode.NOERROR
  }

  private run(zone: string, force: boolean): Promise<TransferResult> {
    const existing = this.running.get(zone)
    if (existing) return existing
    const p = this.execute(zone, force).finally(() => this.running.delete(zone))
    this.running.set(zone, p)
    return p
  }

  private async execute(zone: string, force: boolean): Promise<TransferResult> {
    const row = this.repo.getZone(zone)
    if (!row || row.kind !== 'slave') throw new Error(`${zone} is not a secondary zone`)
    const targets = row.masters.map(parseTarget)
    const errors: string[] = []

    for (const target of targets) {
      try {
        await this.rememberIps(zone, target)
        const local = this.index.get(zone)?.serial
        if (!force && local !== undefined) {
          const remote = await this.io.soaSerial(target, zone)
          if (!serialGt(remote, local)) {
            this.zones.markCheck(zone, {})
            this.schedule(zone, true)
            return { updated: false, serial: local, records: 0, skipped: {} }
          }
        }
        const data = await this.io.axfr(target, zone)
        const result = this.zones.applyTransfer(zone, data.rrsets, data.skipped, `${target.host}:${target.port}`)
        this.schedule(zone, true)
        this.log.log(`${zone}: transferred serial ${data.serial} (${result.records} records) from ${target.host}`)
        return { updated: true, serial: data.serial, records: result.records, skipped: data.skipped }
      } catch (e) {
        errors.push(`${target.host}: ${(e as Error).message}`)
      }
    }
    const message = errors.join('; ') || 'no primaries configured'
    this.zones.markCheck(zone, { error: message })
    this.schedule(zone, false)
    this.log.warn(`${zone}: ${message}`)
    throw new Error(message)
  }

  private schedule(zone: string, ok: boolean): void {
    const soa = this.index.get(zone)?.soaContent
    this.nextAt.set(zone, this.now() + nextDelaySeconds(soa, ok) * 1000)
  }

  private async rememberIps(zone: string, target: Target): Promise<void> {
    const set = this.masterIps.get(zone) ?? new Set<string>()
    if (isIPLiteral(target.host)) set.add(normalizeIp(target.host))
    else {
      try {
        for (const a of await dns.lookup(target.host, { all: true })) set.add(normalizeIp(a.address))
      } catch {
        /* the transfer itself will report the failure */
      }
    }
    this.masterIps.set(zone, set)
  }
}
