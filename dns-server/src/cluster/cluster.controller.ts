import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Post, Req, VERSION_NEUTRAL } from '@nestjs/common'
import type { Request } from 'express'
import { Roles, SessionOnly, Public } from '../auth/principal.js'
import { EnvelopeError } from './envelope.js'
import { CLUSTER, type ClusterRuntime } from './cluster.runtime.js'

/** Where peers talk to each other. No login: the cluster secret and the peer's address are the credentials. */
@Controller({ path: 'cluster/v1', version: VERSION_NEUTRAL })
export class ClusterPeerController {
  constructor(@Inject(CLUSTER) private readonly cluster: ClusterRuntime | null) {}

  private runtime(): ClusterRuntime {
    if (!this.cluster) throw new NotFoundException()
    return this.cluster
  }

  /** Every failure looks the same to the caller: a stranger learns nothing about which check failed. */
  private open<T>(req: Request, route: string, body: unknown): T {
    try {
      return this.runtime().gate.openRequest<T>(req.ip, route, (body as { d?: unknown } | null)?.d)
    } catch (e) {
      if (e instanceof EnvelopeError) throw new ForbiddenException('forbidden')
      throw e
    }
  }

  @Public()
  @Post('changes')
  @HttpCode(200)
  changes(@Req() req: Request, @Body() body: unknown) {
    const { since, limit } = this.open<{ since?: unknown; limit?: unknown }>(req, 'changes', body)
    const s = typeof since === 'number' && since >= 0 ? Math.floor(since) : 0
    const l = typeof limit === 'number' ? Math.min(1000, Math.max(1, Math.floor(limit))) : 500
    const rt = this.runtime()
    return { d: rt.gate.sealResponse('changes', rt.service.handleChanges(s, l)) }
  }

  @Public()
  @Post('nudge')
  @HttpCode(200)
  nudge(@Req() req: Request, @Body() body: unknown) {
    this.open(req, 'nudge', body)
    const rt = this.runtime()
    rt.service.handleNudge()
    return { d: rt.gate.sealResponse('nudge', { ok: true }) }
  }
}

/** For the console: how the cluster is doing, and a "sync now" button. */
@Controller('cluster')
export class ClusterAdminController {
  constructor(@Inject(CLUSTER) private readonly cluster: ClusterRuntime | null) {}

  @Get()
  @Roles('admin')
  status() {
    if (!this.cluster) return { enabled: false }
    return { enabled: true, ...this.cluster.service.status(), allowedAddresses: this.cluster.gate.addresses }
  }

  @Post('sync')
  @Roles('admin')
  @SessionOnly()
  @HttpCode(200)
  async sync() {
    if (!this.cluster) throw new NotFoundException('cluster mode is off')
    const results = await this.cluster.service.syncAll()
    return { results, ...this.cluster.service.status() }
  }
}
