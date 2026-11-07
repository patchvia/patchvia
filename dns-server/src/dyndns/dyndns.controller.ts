import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query, Req, Res, VERSION_NEUTRAL } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { Actor } from '../auth/actor.decorator.js'
import { canAccessZone, Public, type Principal } from '../auth/principal.js'
import { parse } from '../common/parse.js'
import { ZoneService } from '../zones/zone-service.js'
import { NotFoundError } from '../zones/zone-service.js'
import { DynDnsService, type UpdateOutcome } from './dyndns.service.js'

const HTTP_STATUS: Record<string, number> = { good: 200, nochg: 200, badauth: 401, nohost: 404, badip: 400, abuse: 429, conflict: 409 }

function bearerOrBasicSecret(req: Request): string | undefined {
  const h = req.headers.authorization
  if (!h) return undefined
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  if (h.startsWith('Basic ')) {
    // DynDNS2 clients send user:password; the password is the token and the user name is ignored
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8')
    return decoded.slice(decoded.indexOf(':') + 1)
  }
  return undefined
}

const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)

/** Simple JSON endpoint: GET/POST /dyn/update?token=…&ip=…  (no /v1 prefix: this is what devices are configured with) */
@Controller({ path: 'dyn', version: VERSION_NEUTRAL })
export class DynUpdateController {
  constructor(@Inject(DynDnsService) private readonly dyn: DynDnsService) {}

  @Public()
  @Get('update')
  @HttpCode(200)
  get(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query() q: Record<string, unknown>) {
    return this.handle(req, res, q)
  }

  /** Same as GET: some clients and scripts prefer to POST. */
  @Public()
  @Post('update')
  @HttpCode(200)
  post(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query() q: Record<string, unknown>) {
    return this.handle(req, res, q)
  }

  private handle(req: Request, res: Response, q: Record<string, unknown>) {
    const token = first(q.token) ?? bearerOrBasicSecret(req)
    const given = [first(q.ip), first(q.ipv4), first(q.ip6), first(q.ipv6), first(q.myip)].flatMap((v) => (v ? v.split(',') : []))
    // With no address given the update uses the one the request came from
    const candidates = given.length ? given : [req.ip]
    const out = this.dyn.update(token, candidates, req.ip ?? 'unknown')
    res.status(HTTP_STATUS[out.status] ?? 500)
    return out
  }
}

/** DynDNS2-compatible endpoint, the protocol most routers and ddclient speak: /nic/update?hostname=…&myip=… */
@Controller({ path: 'nic', version: VERSION_NEUTRAL })
export class DynDns2Controller {
  constructor(@Inject(DynDnsService) private readonly dyn: DynDnsService) {}

  @Public()
  @Get('update')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  update(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query() q: Record<string, unknown>): string {
    const hostname = first(q.hostname)
    if (!hostname) return 'notfqdn'
    const given = (first(q.myip) ?? '').split(',').filter(Boolean)
    const out = this.dyn.update(bearerOrBasicSecret(req), given.length ? given : [req.ip], req.ip ?? 'unknown', hostname)
    return this.dyn2Reply(out, res)
  }

  private dyn2Reply(out: UpdateOutcome, res: Response): string {
    switch (out.status) {
      case 'good':
      case 'nochg':
        return `${out.status} ${[out.ip4, out.ip6].filter(Boolean).join(',')}`
      case 'badauth':
        res.status(401)
        return 'badauth'
      case 'nohost':
        return 'nohost'
      case 'badip':
        return 'dnserr'
      case 'abuse':
        return 'abuse'
      default:
        return 'dnserr'
    }
  }
}

const createSchema = z.object({ name: z.string().trim().min(1).max(255), ttl: z.number().int().min(1).max(86400).optional() })
const patchSchema = z.object({ ttl: z.number().int().min(1).max(86400) })

/** Managing tokens: anyone who can edit a zone's records can hand out tokens for names in it. */
@Controller('zones/:zone/dyndns')
export class DynDnsManagementController {
  constructor(
    @Inject(DynDnsService) private readonly dyn: DynDnsService,
    @Inject(ZoneService) private readonly zones: ZoneService,
  ) {}

  private access(p: Principal, zone: string): void {
    if (!canAccessZone(p, this.zones.getZone(zone))) throw new NotFoundError(`zone ${zone} not found`)
  }

  @Get()
  list(@Actor() p: Principal, @Param('zone') zone: string) {
    this.access(p, zone)
    return this.dyn.list(zone)
  }

  /** The secret is in this response only. */
  @Post()
  create(@Actor() p: Principal, @Param('zone') zone: string, @Body() body: unknown) {
    this.access(p, zone)
    const b = parse(createSchema, body)
    return this.dyn.create(zone, b, p.username)
  }

  @Patch(':id')
  update(@Actor() p: Principal, @Param('zone') zone: string, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    this.access(p, zone)
    return this.dyn.setTtl(zone, id, parse(patchSchema, body).ttl)
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Actor() p: Principal, @Param('zone') zone: string, @Param('id', ParseIntPipe) id: number) {
    this.access(p, zone)
    this.dyn.delete(zone, id, p.username)
  }
}
