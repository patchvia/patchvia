import { Controller, Get, Header, Inject, Query } from '@nestjs/common'
import { Public, Roles } from '../auth/principal.js'
import { CONFIG, type Config } from '../config/config.js'
import { CLUSTER, type ClusterRuntime } from '../cluster/cluster.runtime.js'
import { Notifier } from '../replication/notifier.js'
import { AuditRepository } from '../zones/audit-repository.js'
import { Stats, renderMetrics } from '../dns/stats.js'
import { ZoneIndex } from '../zones/zone-index.js'
import { ZoneService } from '../zones/zone-service.js'

@Controller('server')
export class ServerController {
  constructor(
    @Inject(Stats) private readonly stats: Stats,
    @Inject(ZoneIndex) private readonly index: ZoneIndex,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(ZoneService) private readonly zoneService: ZoneService,
    @Inject(CLUSTER) private readonly cluster: ClusterRuntime | null,
  ) {}

  /** For container healthchecks; reveals nothing beyond liveness. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' }
  }

  @Get('stats')
  getStats() {
    return { ...this.stats.snapshot(), zones: this.index.size }
  }

  /** Prometheus scrape endpoint. Any read-scope API key works as the bearer token. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics() {
    const zones = this.zoneService.listZones()
    const secondaries = zones.filter((z) => z.kind === 'slave')
    return renderMetrics({
      stats: this.stats.snapshot(),
      zones: this.index.size,
      records: zones.reduce((n, z) => n + z.recordCount, 0),
      dnssecZones: zones.filter((z) => z.dnssec).length,
      secondaryZones: secondaries.length,
      secondaryFailing: secondaries.filter((z) => z.transferError).length,
      cluster: this.cluster
        ? (() => {
            const peers = this.cluster.service.status().peers
            const failing = peers.filter((p) => p.lastError).length
            const joining = peers.filter((p) => !p.lastError && !p.lastContact).length
            return { peersConnected: peers.length - failing - joining, peersFailing: failing, peersJoining: joining }
          })()
        : undefined,
    })
  }

  /** Non-secret replication settings, so the console can show how secondaries are expected to connect. */
  @Roles('admin', 'operator')
  @Get('replication')
  replication() {
    return {
      allowAxfrFrom: this.cfg.allowAxfrFrom,
      notifyTo: this.notifier.targetNames,
      defaultNameservers: this.cfg.defaultNameservers,
    }
  }

  /** Recent changes across all zones, newest first. */
  @Roles('admin', 'operator')
  @Get('activity')
  activity(@Query('limit') limit?: string, @Query('before') before?: string) {
    return this.audit.list({ limit: limit ? Math.max(1, Number(limit) || 20) : 20, before: before ? Number(before) || undefined : undefined })
  }
}
