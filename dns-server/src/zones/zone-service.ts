import { normalizeName, validateName, ValidationError } from '../dns/names.js'
import { STORABLE_TYPES, type RTypeName } from '../dns/types.js'
import { parseTarget } from '../replication/target.js'
import type { DnssecKeyRepository, StoredKey } from '../dnssec/key-repository.js'
import { ALGORITHM_NAMES, dnskeyPresentation, dsRecords, generateKey, type DsRecord } from '../dnssec/keys.js'
import { ZoneSigner } from '../dnssec/signer.js'
import type { AuditRepository } from './audit-repository.js'
import { nextSerial } from './serial.js'
import { ZoneIndex } from './zone-index.js'
import { assertNoCnameConflict, buildZone, compileRRset, type RRsetInput, type Zone } from './zone.js'
import type { StoredRecord, StoredRRset, ZoneRepository, ZoneRow } from './zone-repository.js'

/** Told when a zone's replicated data (records, properties, keys, tokens) changes, so the cluster can capture it. */
export interface ZoneHooks {
  zoneTouched(zone: string): void
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export interface Ctx {
  actor: string
  now?: Date
}
const SYSTEM: Ctx = { actor: 'system' }

const READ_ONLY = 'this is a secondary zone: its records come from the primary and cannot be edited here'

const toStored = (s: RRsetInput): StoredRRset => ({
  name: s.name,
  type: s.type,
  ttl: s.ttl,
  records: s.contents.map((content) => ({ content, disabled: false })),
})

function soaSerialOf(content: string | undefined): string | undefined {
  return content?.trim().split(/\s+/)[2]
}

export interface RRsetChange {
  name: string
  type: RTypeName
  changetype: 'REPLACE' | 'DELETE'
  ttl?: number
  records?: StoredRecord[]
}

export interface CreateZoneInput {
  name: string
  kind?: 'native' | 'master' | 'slave'
  nameservers: string[]
  ttl?: number
  hostmaster?: string
  accountId?: number | null
  /** Primaries to transfer from; required (and only used) for secondary zones */
  masters?: string[]
  /** Extra records created atomically with the zone. */
  rrsets?: RRsetChange[]
}

export interface ZoneSummary extends ZoneRow {
  serial: number
  recordCount: number
  /** Signed with DNSSEC */
  dnssec: boolean
}

export interface DnssecKeyView {
  id: number
  keyTag: number
  algorithm: number
  algorithmName: string
  flags: number
  /** KSK = secure entry point only, ZSK = zone key only, CSK = both (the default here) */
  role: 'CSK' | 'KSK' | 'ZSK'
  active: boolean
  published: boolean
  createdAt: string
  /** DNSKEY rdata as shown by `dig`: flags protocol algorithm key */
  dnskey: string
  /** DS records to give the parent zone or registrar; only for keys that are secure entry points */
  ds: (DsRecord & { text: string })[]
}

export interface DnssecStatus {
  enabled: boolean
  keys: DnssecKeyView[]
}

/** Application layer for zones: validates, persists, bumps serials, audits, and keeps the live index in sync. */
export class ZoneService {
  constructor(
    private readonly repo: ZoneRepository,
    private readonly index: ZoneIndex,
    private readonly audit?: AuditRepository,
    /** Called after a zone's contents change (NOTIFY hook) */
    private readonly onChange?: (zone: string) => void,
    private readonly keys?: DnssecKeyRepository,
  ) {}

  private hooks?: ZoneHooks

  setHooks(h: ZoneHooks): void {
    this.hooks = h
  }

  private touch(zone: string): void {
    this.hooks?.zoneTouched(zone)
  }

  /**
   * Rebuilds one zone in the live index from the database. Used after the cluster changed the tables directly. If the
   * zone cannot be built right now (no SOA yet, or no signing key active mid-sync) the previous version keeps serving.
   */
  reloadZone(name: string): { ok: boolean; error?: string } {
    const row = this.repo.getZone(name)
    if (!row) {
      this.index.delete(name)
      return { ok: true }
    }
    try {
      this.index.set(this.compile(row))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  dropZone(name: string): void {
    this.index.delete(name)
  }

  /** Compiles every stored zone into the index. A broken zone is skipped and reported, never fatal. */
  loadAll(): { loaded: number; failed: { zone: string; error: string }[] } {
    const failed: { zone: string; error: string }[] = []
    let loaded = 0
    for (const row of this.repo.listZones()) {
      try {
        this.index.set(this.compile(row))
        loaded++
      } catch (err) {
        // A secondary that has not completed its first transfer has no records yet: not an error
        if (row.kind === 'slave' && this.repo.getRRsets(row.id).length === 0) continue
        failed.push({ zone: row.name, error: (err as Error).message })
      }
    }
    return { loaded, failed }
  }

  listZones(): ZoneSummary[] {
    return this.repo.listZones().map((z) => this.summarise(z))
  }

  getZone(name: string): ZoneSummary {
    return this.summarise(this.requireZone(name))
  }

  private summarise(row: ZoneRow): ZoneSummary {
    const zone = this.index.get(row.name)
    return { ...row, serial: zone?.serial ?? 0, recordCount: zone?.recordCount ?? 0, dnssec: zone?.signed ?? false }
  }

  getRRsets(zoneName: string): StoredRRset[] {
    return this.repo.getRRsets(this.requireZone(zoneName).id)
  }

  createZone(input: CreateZoneInput, ctx: Ctx = SYSTEM): ZoneRow {
    const name = normalizeName(input.name)
    if (name === '') throw new ValidationError('zone name is required')
    validateName(name)
    if (this.repo.getZone(name)) throw new ConflictError(`zone ${name} already exists`)
    if (input.kind === 'slave') return this.createSecondary(name, input, ctx)
    if (input.nameservers.length === 0) throw new ValidationError('at least one nameserver is required')
    const ttl = input.ttl ?? 3600
    const hostmaster = normalizeName(input.hostmaster ?? `hostmaster.${name}`)
    const kind = input.kind ?? 'native'
    const soa = `${normalizeName(input.nameservers[0]!)} ${hostmaster} ${nextSerial(0, ctx.now)} 10800 3600 604800 3600`

    const { row, zone } = this.repo.transaction(() => {
      const row = this.repo.insertZone(name, kind, input.accountId ?? null)
      this.repo.replaceRRset(row.id, name, 'SOA', ttl, [{ content: soa, disabled: false }])
      this.repo.replaceRRset(
        row.id,
        name,
        'NS',
        ttl,
        input.nameservers.map((ns) => ({ content: normalizeName(ns), disabled: false })),
      )
      if (input.rrsets?.length) this.applyInTx(row, input.rrsets, ctx, false)
      this.audit?.insert({ actor: ctx.actor, zone: name, action: 'zone.create', detail: { kind, nameservers: input.nameservers } })
      return { row, zone: this.compile(row) } // validates before commit
    })
    this.index.set(zone)
    this.onChange?.(name)
    this.touch(name)
    return row
  }

  private createSecondary(name: string, input: CreateZoneInput, ctx: Ctx): ZoneRow {
    const masters = this.validMasters(input.masters)
    return this.repo.transaction(() => {
      const row = this.repo.insertZone(name, 'slave', input.accountId ?? null, masters)
      this.audit?.insert({ actor: ctx.actor, zone: name, action: 'zone.create', detail: { kind: 'slave', masters } })
      return row
    })
  }

  private validMasters(masters: string[] | undefined): string[] {
    const list = (masters ?? []).map((m) => m.trim()).filter(Boolean)
    if (list.length === 0) throw new ValidationError('a secondary zone needs at least one primary to transfer from')
    for (const m of list) parseTarget(m) // throws ValidationError with a clear message
    return list
  }

  /** Changes the primaries of a secondary zone. */
  setMasters(zoneName: string, masters: string[], ctx: Ctx = SYSTEM): ZoneRow {
    const row = this.requireZone(zoneName)
    if (row.kind !== 'slave') throw new ValidationError('only secondary zones have primaries')
    const list = this.validMasters(masters)
    this.repo.transaction(() => {
      this.repo.setMasters(row.id, list)
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action: 'zone.masters', detail: { from: row.masters, to: list } })
    })
    this.touch(row.name)
    return this.repo.getZone(row.name)!
  }

  /**
   * Turns a secondary into a primary zone: it keeps the data it has, stops transferring, and becomes editable. This is
   * the last step of moving a zone from another server (run as its secondary, check, promote, switch the NS records).
   */
  promote(zoneName: string, ctx: Ctx = SYSTEM): ZoneRow {
    const row = this.requireZone(zoneName)
    if (row.kind !== 'slave') throw new ValidationError('only secondary zones can be promoted')
    if (!this.index.get(row.name)) {
      throw new ValidationError('this zone has not completed its first transfer yet, so there is nothing to promote')
    }
    this.repo.transaction(() => {
      this.repo.setKind(row.id, 'master')
      this.repo.setMasters(row.id, [])
      this.repo.recordCheck(row.id, { error: null })
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action: 'zone.promote', detail: { masters: row.masters, serial: this.index.get(row.name)!.serial } })
    })
    this.onChange?.(row.name)
    this.touch(row.name)
    return this.repo.getZone(row.name)!
  }

  /** Records contact with a primary (success without change, or an error). */
  markCheck(zoneName: string, result: { error?: string | null }): void {
    const row = this.repo.getZone(zoneName)
    if (row) this.repo.recordCheck(row.id, { error: result.error ?? null })
  }

  /**
   * Replaces a secondary's contents with a completed transfer, atomically. Records that do not validate here are
   * skipped and counted rather than failing the whole transfer; a transfer without a usable SOA is rejected.
   */
  applyTransfer(
    zoneName: string,
    sets: RRsetInput[],
    skipped: Record<string, number>,
    source: string,
  ): { records: number } {
    const row = this.requireZone(zoneName)
    const good: RRsetInput[] = []
    const invalid: string[] = []
    for (const set of sets) {
      try {
        compileRRset(row.name, set)
        good.push(set)
      } catch (e) {
        invalid.push(`${set.type} ${set.name}: ${(e as Error).message}`)
      }
    }
    const zone = this.repo.transaction(() => {
      this.repo.replaceAll(row.id, good.map(toStored))
      this.repo.recordCheck(row.id, { transferred: true })
      const compiled = this.compile(row) // requires an SOA; throws and rolls back otherwise
      this.audit?.insert({
        actor: 'transfer',
        zone: row.name,
        action: 'zone.transfer',
        detail: { source, serial: compiled.serial, records: compiled.recordCount, skipped, invalid: invalid.slice(0, 20), invalidCount: invalid.length },
      })
      return compiled
    })
    this.index.set(zone)
    this.onChange?.(row.name)
    return { records: zone.recordCount }
  }

  /**
   * Creates a zone from parsed zone-file records. Missing SOA/NS are filled in from `nameservers`; the file's own
   * SOA (and so its serial) is kept when present. All or nothing.
   */
  createFromImport(
    input: { name: string; sets: RRsetInput[]; kind?: 'native' | 'master'; accountId?: number | null; nameservers?: string[] },
    ctx: Ctx = SYSTEM,
  ): ZoneRow {
    const name = normalizeName(input.name)
    validateName(name)
    if (this.repo.getZone(name)) throw new ConflictError(`zone ${name} already exists`)
    const sets = [...input.sets]
    const has = (type: RTypeName) => sets.some((s) => s.name === name && s.type === type)
    const ns = input.nameservers?.map(normalizeName) ?? []
    if (!has('NS')) {
      if (!ns.length) throw new ValidationError('the zone file has no NS records for the zone: provide nameservers')
      sets.push({ name, type: 'NS', ttl: 3600, contents: ns })
    }
    if (!has('SOA')) {
      const primary = sets.find((s) => s.name === name && s.type === 'NS')!.contents[0]!
      sets.push({ name, type: 'SOA', ttl: 3600, contents: [`${primary} hostmaster.${name} ${nextSerial(0)} 10800 3600 604800 3600`] })
    }
    const { row, zone } = this.repo.transaction(() => {
      const row = this.repo.insertZone(name, input.kind ?? 'native', input.accountId ?? null)
      this.repo.replaceAll(row.id, sets.map((s) => toStored({ ...s, name: normalizeName(s.name) })))
      const zone = this.compile(row) // validates every record against this zone
      this.audit?.insert({ actor: ctx.actor, zone: name, action: 'zone.import', detail: { mode: 'create', records: zone.recordCount } })
      return { row, zone }
    })
    this.index.set(zone)
    this.onChange?.(name)
    this.touch(name)
    return row
  }

  /** Replaces the whole contents of a non-secondary zone, for zone-file imports in replace mode. */
  replaceContents(zoneName: string, sets: RRsetInput[], ctx: Ctx = SYSTEM): { records: number } {
    const row = this.requireZone(zoneName)
    if (row.kind === 'slave') throw new ValidationError(READ_ONLY)
    const zone = this.repo.transaction(() => {
      this.repo.replaceAll(row.id, sets.map((s) => toStored({ ...s, name: normalizeName(s.name) })))
      const compiled = this.compile(row)
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action: 'zone.import', detail: { mode: 'replace', records: compiled.recordCount } })
      return compiled
    })
    this.index.set(zone)
    this.onChange?.(row.name)
    this.touch(row.name)
    return { records: zone.recordCount }
  }

  deleteZone(zoneName: string, ctx: Ctx = SYSTEM): void {
    const row = this.requireZone(zoneName)
    this.repo.transaction(() => {
      this.repo.deleteZone(row.id)
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action: 'zone.delete' })
    })
    this.index.delete(row.name)
    this.touch(row.name)
  }

  setZoneAccount(zoneName: string, accountId: number | null, ctx: Ctx = SYSTEM): void {
    const row = this.requireZone(zoneName)
    this.repo.transaction(() => {
      this.repo.setZoneAccount(row.id, accountId)
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action: 'zone.account', detail: { from: row.accountId, to: accountId } })
    })
    this.touch(row.name)
  }

  /** Applies several RRset changes as one transaction and one serial bump. Nothing is written if any change is invalid. */
  applyChanges(zoneName: string, changes: RRsetChange[], ctx: Ctx = SYSTEM): void {
    const row = this.requireZone(zoneName)
    if (row.kind === 'slave') throw new ValidationError(READ_ONLY)
    if (changes.length === 0) throw new ValidationError('no changes given')
    const zone = this.repo.transaction(() => {
      this.applyInTx(row, changes, ctx, true)
      return this.compile(row)
    })
    this.index.set(zone)
    this.onChange?.(row.name)
    this.touch(row.name)
  }

  getRRset(zoneName: string, name: string, type: RTypeName): StoredRRset | undefined {
    const row = this.requireZone(zoneName)
    return this.repo.getRRset(row.id, normalizeName(name), type)
  }

  setRRset(zoneName: string, name: string, type: RTypeName, ttl: number, records: StoredRecord[], ctx: Ctx = SYSTEM): void {
    this.applyChanges(zoneName, [{ name, type, changetype: 'REPLACE', ttl, records }], ctx)
  }

  deleteRRset(zoneName: string, name: string, type: RTypeName, ctx: Ctx = SYSTEM): void {
    this.applyChanges(zoneName, [{ name, type, changetype: 'DELETE' }], ctx)
  }

  private applyInTx(row: ZoneRow, changes: RRsetChange[], ctx: Ctx, bump: boolean): void {
    let soaTouched = false
    for (const ch of changes) {
      if (!STORABLE_TYPES.includes(ch.type)) throw new ValidationError(`unsupported record type: ${ch.type}`)
      const owner = normalizeName(ch.name)
      const before = this.repo.getRRset(row.id, owner, ch.type)
      if (ch.changetype === 'DELETE') {
        if (owner === row.name && (ch.type === 'SOA' || ch.type === 'NS')) throw new ValidationError(`cannot delete apex ${ch.type}`)
        if (!before) throw new NotFoundError(`no ${ch.type} record at ${owner}`)
        this.repo.deleteRRset(row.id, owner, ch.type)
      } else {
        const records = ch.records ?? []
        const ttl = ch.ttl ?? before?.ttl ?? 3600
        compileRRset(row.name, { name: owner, type: ch.type, ttl, contents: records.map((r) => r.content) })
        // An SOA edit that carries a different serial is the operator choosing the serial; otherwise we still bump
        if (ch.type === 'SOA' && soaSerialOf(records[0]?.content) !== soaSerialOf(before?.records[0]?.content)) soaTouched = true
        assertNoCnameConflict(
          owner,
          this.repo.typesAt(row.id, owner).filter((t) => t !== ch.type),
          ch.type,
        )
        this.repo.replaceRRset(row.id, owner, ch.type, ttl, records)
      }
      this.audit?.insert({
        actor: ctx.actor,
        zone: row.name,
        action: ch.changetype === 'DELETE' ? 'rrset.delete' : 'rrset.replace',
        detail: {
          name: owner,
          type: ch.type,
          before: before && { ttl: before.ttl, records: before.records },
          after: ch.changetype === 'DELETE' ? null : { ttl: ch.ttl ?? before?.ttl ?? 3600, records: ch.records ?? [] },
        },
      })
    }
    if (bump && !soaTouched) this.bumpSerial(row, ctx.now ?? new Date())
  }

  // ---- DNSSEC ------------------------------------------------------------------------------------------------------

  dnssecStatus(zoneName: string): DnssecStatus {
    const row = this.requireZone(zoneName)
    const keys = this.keys?.list(row.id) ?? []
    return { enabled: keys.length > 0, keys: keys.map((k) => this.keyView(row.name, k)) }
  }

  /** Starts signing a zone with a new combined signing key. The DS record must then be given to the parent. */
  enableDnssec(zoneName: string, ctx: Ctx = SYSTEM): DnssecStatus {
    const row = this.requireZone(zoneName)
    const repo = this.requireKeys()
    if (row.kind === 'slave') throw new ValidationError('secondary zones cannot be signed here: the primary signs them')
    if (repo.list(row.id).length > 0) throw new ConflictError(`DNSSEC is already enabled for ${row.name}`)
    this.rebuild(row, ctx, 'dnssec.enable', () => {
      const k = generateKey()
      repo.insert(row.id, { ...k, active: true, published: true })
      return { keyTag: k.keyTag }
    })
    return this.dnssecStatus(row.name)
  }

  /** Stops signing. If the parent still has a DS record for this zone, validating resolvers will reject it: remove the DS first. */
  disableDnssec(zoneName: string, ctx: Ctx = SYSTEM): DnssecStatus {
    const row = this.requireZone(zoneName)
    const repo = this.requireKeys()
    if (repo.list(row.id).length === 0) throw new ValidationError(`DNSSEC is not enabled for ${row.name}`)
    this.rebuild(row, ctx, 'dnssec.disable', () => {
      repo.deleteAll(row.id)
      return {}
    })
    return this.dnssecStatus(row.name)
  }

  /** Adds a second key for a rollover: it is published (so resolvers can learn it) but does not sign until activated. */
  addDnssecKey(zoneName: string, ctx: Ctx = SYSTEM): DnssecStatus {
    const row = this.requireZone(zoneName)
    const repo = this.requireKeys()
    if (repo.list(row.id).length === 0) throw new ValidationError(`DNSSEC is not enabled for ${row.name}`)
    this.rebuild(row, ctx, 'dnssec.key.add', () => {
      const k = generateKey()
      repo.insert(row.id, { ...k, active: false, published: true })
      return { keyTag: k.keyTag }
    })
    return this.dnssecStatus(row.name)
  }

  /**
   * Changes a key's state. A key signs only while published, and at least one key must always sign. Rollover is:
   * add a key, give its DS to the parent, wait out the old DS TTL, activate the new key, deactivate then remove the old.
   */
  updateDnssecKey(zoneName: string, keyId: number, patch: { active?: boolean; published?: boolean }, ctx: Ctx = SYSTEM): DnssecStatus {
    const row = this.requireZone(zoneName)
    const repo = this.requireKeys()
    const all = repo.list(row.id)
    const key = all.find((k) => k.id === keyId)
    if (!key) throw new NotFoundError(`key ${keyId} not found`)
    const next = { active: patch.active ?? key.active, published: patch.published ?? key.published }
    if (next.active && !next.published) throw new ValidationError('a key must be published before it can sign')
    const stillActive = all.filter((k) => (k.id === keyId ? next.active : k.active)).length
    if (stillActive === 0) throw new ValidationError('at least one key must keep signing the zone')
    this.rebuild(row, ctx, 'dnssec.key.update', () => {
      repo.update(keyId, patch)
      return { keyTag: key.keyTag, ...next }
    })
    return this.dnssecStatus(row.name)
  }

  deleteDnssecKey(zoneName: string, keyId: number, ctx: Ctx = SYSTEM): DnssecStatus {
    const row = this.requireZone(zoneName)
    const repo = this.requireKeys()
    const key = repo.list(row.id).find((k) => k.id === keyId)
    if (!key) throw new NotFoundError(`key ${keyId} not found`)
    if (key.active) throw new ValidationError('deactivate the key before deleting it')
    this.rebuild(row, ctx, 'dnssec.key.delete', () => {
      repo.delete(keyId)
      return { keyTag: key.keyTag }
    })
    return this.dnssecStatus(row.name)
  }

  /** Applies a key change and recompiles the zone in one transaction, so a bad key set can never go live. */
  private rebuild(row: ZoneRow, ctx: Ctx, action: string, change: () => Record<string, unknown>): void {
    const zone = this.repo.transaction(() => {
      const detail = change()
      this.audit?.insert({ actor: ctx.actor, zone: row.name, action, detail })
      return this.compile(row)
    })
    this.index.set(zone)
    this.touch(row.name)
  }

  private requireKeys(): DnssecKeyRepository {
    if (!this.keys) throw new ValidationError('DNSSEC is not available')
    return this.keys
  }

  private keyView(zone: string, k: StoredKey): DnssecKeyView {
    const sep = (k.flags & 1) !== 0
    return {
      id: k.id,
      keyTag: k.keyTag,
      algorithm: k.algorithm,
      algorithmName: ALGORITHM_NAMES[k.algorithm] ?? `ALG${k.algorithm}`,
      flags: k.flags,
      role: sep ? ((k.flags & 256) !== 0 ? 'CSK' : 'KSK') : 'ZSK',
      active: k.active,
      published: k.published,
      createdAt: k.createdAt,
      dnskey: dnskeyPresentation(k),
      ds: sep ? dsRecords(zone, k).map((d) => ({ ...d, text: `${d.keyTag} ${d.algorithm} ${d.digestType} ${d.digest}` })) : [],
    }
  }

  private requireZone(name: string): ZoneRow {
    const row = this.repo.getZone(normalizeName(name))
    if (!row) throw new NotFoundError(`zone ${name} not found`)
    return row
  }

  private bumpSerial(row: ZoneRow, now: Date): void {
    const soa = this.repo.getRRset(row.id, row.name, 'SOA')
    const rec = soa?.records[0]
    if (!soa || !rec) throw new ValidationError(`zone ${row.name} has no SOA record`)
    const parts = rec.content.trim().split(/\s+/)
    parts[2] = String(nextSerial(Number(parts[2]), now))
    this.repo.replaceRRset(row.id, row.name, 'SOA', soa.ttl, [{ content: parts.join(' '), disabled: false }])
  }

  private compile(row: ZoneRow): Zone {
    const sets = this.repo
      .getRRsets(row.id)
      .map((s) => ({ name: s.name, type: s.type, ttl: s.ttl, contents: s.records.filter((r) => !r.disabled).map((r) => r.content) }))
      .filter((s) => s.contents.length > 0)
    const keys = row.kind === 'slave' ? [] : (this.keys?.list(row.id) ?? [])
    return buildZone(row.name, sets, keys.length ? { signer: new ZoneSigner(row.name, keys) } : {})
  }
}
