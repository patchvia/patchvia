import { BadGatewayException, Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common'
import { z } from 'zod'
import { Actor } from '../auth/actor.decorator.js'
import { canAccessZone, Roles, type Principal } from '../auth/principal.js'
import { parse } from '../common/parse.js'
import { CONFIG, type Config } from '../config/config.js'
import { normalizeName, ValidationError } from '../dns/names.js'
import { STORABLE_TYPES, type RTypeName } from '../dns/types.js'
import { Notifier } from '../replication/notifier.js'
import { SecondaryManager } from '../replication/secondary.js'
import { UsersService } from '../users/users.service.js'
import { AuditRepository } from './audit-repository.js'
import { exportZoneFile } from './zonefile.js'
import { parseZoneFile } from './zonefile-parser.js'
import { NotFoundError, ZoneService, type RRsetChange } from './zone-service.js'

const type = z.enum(STORABLE_TYPES as unknown as [RTypeName, ...RTypeName[]])
const record = z.object({ content: z.string().min(1).max(4096), disabled: z.boolean().default(false) })
const hostname = z.string().min(1).max(255)
const changeSchema = z.object({
  name: hostname,
  type,
  changetype: z.enum(['REPLACE', 'DELETE']).default('REPLACE'),
  ttl: z.number().int().min(0).max(2147483647).optional(),
  records: z.array(record).max(1000).optional(),
})
const createSchema = z.object({
  name: hostname,
  kind: z.enum(['native', 'master', 'slave']).default('native'),
  nameservers: z.array(hostname).optional(),
  ttl: z.number().int().min(0).max(2147483647).optional(),
  hostmaster: hostname.optional(),
  accountId: z.number().int().nullable().optional(),
  masters: z.array(hostname).max(10).optional(),
  rrsets: z.array(changeSchema).max(1000).optional(),
})
const patchSchema = z
  .object({
    accountId: z.number().int().nullable().optional(),
    masters: z.array(hostname).max(10).optional(),
    /** The only kind change allowed: secondary to primary */
    kind: z.literal('master').optional(),
  })
  .refine((b) => b.accountId !== undefined || b.masters !== undefined || b.kind !== undefined, 'nothing to change')
const importSchema = z.object({
  zonefile: z.string().min(1).max(8_000_000),
  name: hostname.optional(),
  mode: z.enum(['create', 'replace']).default('create'),
  kind: z.enum(['native', 'master']).default('native'),
  accountId: z.number().int().nullable().optional(),
  nameservers: z.array(hostname).optional(),
  dryRun: z.boolean().default(false),
})
const keyPatchSchema = z
  .object({ active: z.boolean().optional(), published: z.boolean().optional() })
  .refine((b) => b.active !== undefined || b.published !== undefined, 'nothing to change')
const rrsetsSchema = z.object({ rrsets: z.array(changeSchema).min(1).max(1000) })

@Controller('zones')
export class ZonesController {
  constructor(
    @Inject(ZoneService) private readonly zones: ZoneService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(SecondaryManager) private readonly secondary: SecondaryManager,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  /** 404 (not 403) for zones a user may not see, so zone names are not leaked. */
  private visible(p: Principal, name: string) {
    const zone = this.zones.getZone(name)
    if (!canAccessZone(p, zone)) throw new NotFoundError(`zone ${name} not found`)
    return zone
  }

  private changes(zone: string, input: z.infer<typeof changeSchema>[]): RRsetChange[] {
    return input.map((c) => {
      const name = c.name === '@' ? zone : normalizeName(c.name)
      if (c.changetype === 'REPLACE' && (c.ttl === undefined || !c.records?.length)) {
        throw new ValidationError(`REPLACE of ${c.type} ${name} needs a ttl and at least one record`)
      }
      return { name, type: c.type, changetype: c.changetype, ttl: c.ttl, records: c.records }
    })
  }

  /**
   * Imports an RFC 1035 zone file as a new zone, or replaces the records of an existing one. With `dryRun` nothing is
   * written and the response says what would happen, including every problem found.
   */
  @Post('import')
  @Roles('admin', 'operator')
  @HttpCode(200)
  importZone(@Actor() p: Principal, @Body() body: unknown) {
    const b = parse(importSchema, body)
    const parsed = parseZoneFile(b.zonefile, { origin: b.name })
    const problems = parsed.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
    const name = b.name ? normalizeName(b.name) : parsed.origin
    const nameservers = b.nameservers?.length ? b.nameservers : this.cfg.defaultNameservers
    if (!name) problems.push('the zone name is unknown: the file has no $ORIGIN, so name the zone explicitly')
    else if (b.name && parsed.origin && parsed.origin !== name) problems.push(`$ORIGIN ${parsed.origin}. does not match the zone name ${name}`)

    let existing: ReturnType<ZoneService['getZone']> | undefined
    if (name) {
      try {
        existing = this.zones.getZone(name)
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e
      }
      if (b.mode === 'create' && existing) problems.push(`zone ${name} already exists: choose "replace" to overwrite its records`)
      if (b.mode === 'replace' && !existing) problems.push(`zone ${name} does not exist`)
      if (existing?.kind === 'slave') problems.push(`${name} is a secondary zone and cannot be edited`)
      // A new zone needs nameservers: from its own NS records, from the request, or from DEFAULT_NS. Say so now, not at the real import.
      if (b.mode === 'create' && !existing && !nameservers.length && !parsed.rrsets.some((s) => s.name === name && s.type === 'NS')) {
        problems.push('the zone file has no NS records for the zone: provide nameservers (or set DEFAULT_NS on the server)')
      }
    }

    const byType: Record<string, number> = {}
    let records = 0
    for (const s of parsed.rrsets) {
      if (s.type === 'SOA') continue
      byType[s.type] = (byType[s.type] ?? 0) + s.contents.length
      records += s.contents.length
    }
    const summary = {
      zone: name ?? null,
      mode: b.mode,
      records,
      rrsets: parsed.rrsets.filter((s) => s.type !== 'SOA').length,
      byType,
      hasSoa: parsed.rrsets.some((s) => s.type === 'SOA'),
      serial: Number(parsed.rrsets.find((s) => s.type === 'SOA')?.contents[0]?.split(' ')[2]) || null,
      skipped: parsed.skipped,
      warnings: parsed.warnings.map((w) => (w.line ? `line ${w.line}: ${w.message}` : w.message)),
      replacing: existing ? existing.recordCount : null,
      problems,
    }
    if (b.dryRun) return { dryRun: true, ok: problems.length === 0, ...summary }
    if (problems.length) throw new ValidationError(problems.slice(0, 8).join('; ') + (problems.length > 8 ? `; and ${problems.length - 8} more` : ''))

    const actor = { actor: p.username }
    if (b.mode === 'create') {
      if (b.accountId) this.users.requireAccount(b.accountId)
      this.zones.createFromImport({ name: name!, sets: parsed.rrsets, kind: b.kind, accountId: b.accountId, nameservers }, actor)
    } else {
      // Keep the zone's own SOA and NS when the file does not bring them
      const current = this.zones.getRRsets(name!)
      const sets = [...parsed.rrsets]
      for (const type of ['SOA', 'NS'] as const) {
        const keep = current.find((c) => c.name === name && c.type === type)
        if (!sets.some((s) => s.name === name && s.type === type) && keep) {
          sets.push({ name: name!, type, ttl: keep.ttl, contents: keep.records.map((r) => r.content) })
        }
      }
      this.zones.replaceContents(name!, sets, actor)
    }
    return { dryRun: false, ok: true, ...summary, zoneDetail: this.detail(name!) }
  }

  @Get()
  list(@Actor() p: Principal) {
    const accounts = new Map(this.users.listAccounts().map((a) => [a.id, a.name]))
    return this.zones
      .listZones()
      .filter((z) => canAccessZone(p, z))
      .map(({ id: _id, ...z }) => ({ ...z, accountName: z.accountId === null ? null : (accounts.get(z.accountId) ?? null) }))
  }

  @Post()
  @Roles('admin', 'operator')
  create(@Actor() p: Principal, @Body() body: unknown) {
    const b = parse(createSchema, body)
    const nameservers = b.nameservers?.length ? b.nameservers : this.cfg.defaultNameservers
    if (b.kind !== 'slave' && !nameservers.length) throw new ValidationError('nameservers are required (no DEFAULT_NS is configured)')
    if (b.accountId) this.users.requireAccount(b.accountId)
    const name = normalizeName(b.name)
    this.zones.createZone({ ...b, nameservers, rrsets: b.rrsets && this.changes(name, b.rrsets) }, { actor: p.username })
    if (b.kind === 'slave') this.secondary.refreshSoon(name) // first transfer starts straight away
    return this.detail(name)
  }

  @Get(':name')
  get(@Actor() p: Principal, @Param('name') name: string) {
    this.visible(p, name)
    return this.detail(name)
  }

  @Patch(':name')
  @Roles('admin', 'operator')
  update(@Actor() p: Principal, @Param('name') name: string, @Body() body: unknown) {
    const b = parse(patchSchema, body)
    if (b.accountId) this.users.requireAccount(b.accountId)
    if (b.kind === 'master') {
      if (b.masters !== undefined) throw new ValidationError('promote and change primaries in separate requests')
      this.zones.promote(name, { actor: p.username })
    }
    if (b.accountId !== undefined) this.zones.setZoneAccount(name, b.accountId, { actor: p.username })
    if (b.masters !== undefined) {
      this.zones.setMasters(name, b.masters, { actor: p.username })
      this.secondary.refreshSoon(normalizeName(name))
    }
    return this.detail(name)
  }

  @Delete(':name')
  @Roles('admin', 'operator')
  @HttpCode(204)
  remove(@Actor() p: Principal, @Param('name') name: string) {
    this.zones.deleteZone(name, { actor: p.username })
  }

  /** Atomic: every change applies or none do, with a single SOA serial bump. */
  @Patch(':name/rrsets')
  patchRRsets(@Actor() p: Principal, @Param('name') name: string, @Body() body: unknown) {
    this.visible(p, name)
    const b = parse(rrsetsSchema, body)
    this.zones.applyChanges(name, this.changes(normalizeName(name), b.rrsets), { actor: p.username })
    return this.detail(name)
  }

  /** Pulls a secondary zone from its primary now, ignoring serials. */
  @Post(':name/retrieve')
  @Roles('admin', 'operator')
  @HttpCode(200)
  async retrieve(@Param('name') name: string) {
    const zone = this.zones.getZone(name)
    if (zone.kind !== 'slave') throw new ValidationError('only secondary zones can be retrieved')
    try {
      const result = await this.secondary.retrieve(zone.name)
      return { ...result, zone: this.detail(name) }
    } catch (e) {
      throw new BadGatewayException((e as Error).message)
    }
  }

  /** Sends NOTIFY to the configured secondaries now. */
  @Post(':name/notify')
  @Roles('admin', 'operator')
  @HttpCode(200)
  async notify(@Param('name') name: string) {
    const zone = this.zones.getZone(name)
    return { zone: zone.name, targets: await this.notifier.notifyNow(zone.name) }
  }

  // ---- DNSSEC ----

  @Get(':name/dnssec')
  dnssec(@Actor() p: Principal, @Param('name') name: string) {
    this.visible(p, name)
    return this.zones.dnssecStatus(name)
  }

  /** Starts signing the zone. The response carries the DS records to publish at the parent. */
  @Post(':name/dnssec')
  @Roles('admin', 'operator')
  @HttpCode(200)
  enableDnssec(@Actor() p: Principal, @Param('name') name: string) {
    return this.zones.enableDnssec(name, { actor: p.username })
  }

  @Delete(':name/dnssec')
  @Roles('admin', 'operator')
  disableDnssec(@Actor() p: Principal, @Param('name') name: string) {
    return this.zones.disableDnssec(name, { actor: p.username })
  }

  @Post(':name/dnssec/keys')
  @Roles('admin', 'operator')
  @HttpCode(200)
  addKey(@Actor() p: Principal, @Param('name') name: string) {
    return this.zones.addDnssecKey(name, { actor: p.username })
  }

  @Patch(':name/dnssec/keys/:id')
  @Roles('admin', 'operator')
  updateKey(@Actor() p: Principal, @Param('name') name: string, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const b = parse(keyPatchSchema, body)
    return this.zones.updateDnssecKey(name, id, b, { actor: p.username })
  }

  @Delete(':name/dnssec/keys/:id')
  @Roles('admin', 'operator')
  deleteKey(@Actor() p: Principal, @Param('name') name: string, @Param('id', ParseIntPipe) id: number) {
    return this.zones.deleteDnssecKey(name, id, { actor: p.username })
  }

  @Get(':name/export')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  export(@Actor() p: Principal, @Param('name') name: string) {
    const zone = this.visible(p, name)
    return exportZoneFile(zone.name, this.zones.getRRsets(name))
  }

  @Get(':name/history')
  history(@Actor() p: Principal, @Param('name') name: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    const zone = this.visible(p, name)
    return this.audit.list({
      zone: zone.name,
      limit: limit ? Math.max(1, Number(limit) || 50) : 50,
      before: before ? Number(before) || undefined : undefined,
    })
  }

  private detail(name: string) {
    const { id: _id, ...zone } = this.zones.getZone(name)
    return { ...zone, rrsets: this.zones.getRRsets(name) }
  }
}
