import { DynamicModule, Inject, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import type Database from 'better-sqlite3'
import { AuthController } from './auth/auth.controller.js'
import { AuthGuard } from './auth/auth.guard.js'
import { AuthService } from './auth/auth.service.js'
import { AllExceptionsFilter } from './common/http-exception.filter.js'
import { CONFIG, type Config } from './config/config.js'
import { openDatabase } from './db/database.js'
import { SettingsRepository } from './db/settings.js'
import { DnssecKeyRepository } from './dnssec/key-repository.js'
import { DynDns2Controller, DynDnsManagementController, DynUpdateController } from './dyndns/dyndns.controller.js'
import { DynDnsRepository } from './dyndns/dyndns.repository.js'
import { DynDnsService } from './dyndns/dyndns.service.js'
import { ClusterAdminController, ClusterPeerController } from './cluster/cluster.controller.js'
import { ClusterTouchInterceptor } from './cluster/cluster.interceptor.js'
import { CLUSTER, CLUSTER_TRANSPORT, type ClusterRuntime } from './cluster/cluster.runtime.js'
import { ClusterService, type ClusterTransport } from './cluster/cluster.service.js'
import { HttpClusterTransport } from './cluster/http-transport.js'
import { parsePeerAddress } from './cluster/peer-address.js'
import { PeerGate } from './cluster/peer-gate.js'
import { ClusterStore } from './cluster/store.js'
import { Stats } from './dns/stats.js'
import { realIO, type ReplicationIO } from './replication/io.js'
import { Notifier } from './replication/notifier.js'
import { SecondaryManager } from './replication/secondary.js'
import { parseTarget } from './replication/target.js'
import { ServerController } from './server/server.controller.js'
import { ApiKeysController } from './users/api-keys.controller.js'
import { UsersRepository } from './users/users.repository.js'
import { AccountsController, UsersController } from './users/users.controller.js'
import { UsersService } from './users/users.service.js'
import { AuditRepository } from './zones/audit-repository.js'
import { ZoneIndex } from './zones/zone-index.js'
import { ZoneRepository } from './zones/zone-repository.js'
import { ZoneService } from './zones/zone-service.js'
import { ZonesController } from './zones/zones.controller.js'

export const DB = 'DB'
export const REPLICATION_IO = 'REPLICATION_IO'

/** Loads stored zones into the live index at startup and closes the database on shutdown. */
@Injectable()
class Lifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Zones')
  constructor(
    @Inject(ZoneService) private readonly zones: ZoneService,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(SecondaryManager) private readonly secondary: SecondaryManager,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(CLUSTER) private readonly cluster: ClusterRuntime | null,
  ) {}

  async onModuleInit() {
    const { loaded, failed } = this.zones.loadAll()
    this.log.log(`loaded ${loaded} zone(s)`)
    for (const f of failed) this.log.error(`zone ${f.zone} is NOT served: ${f.error}`)
    this.secondary.start()
    if (this.cluster) {
      await this.cluster.gate.start()
      this.cluster.service.start()
      this.log.log(`cluster mode: node ${this.cluster.service.nodeId}, ${this.cluster.service.peers.length} peer(s)`)
    }
  }

  private closed = false

  onApplicationShutdown() {
    // Nest's signal hooks and main.ts's own handler can both end up here; the second run must not touch a closed database
    if (this.closed) return
    this.closed = true
    this.secondary.stop()
    this.cluster?.service.stop()
    this.cluster?.gate.stop()
    this.notifier.stop()
    this.db.close()
  }
}

@Module({})
export class AppModule {
  /** `deps.io` lets tests replace the network used for transfers and NOTIFY. */
  static register(cfg: Config, deps: { io?: ReplicationIO; clusterTransport?: ClusterTransport } = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        ZonesController,
        UsersController,
        AccountsController,
        ApiKeysController,
        ServerController,
        ClusterPeerController,
        ClusterAdminController,
        DynDnsManagementController,
        DynUpdateController,
        DynDns2Controller,
      ],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: DB, useFactory: () => openDatabase(cfg.dbPath) },
        { provide: ZoneRepository, useFactory: (db: Database.Database) => new ZoneRepository(db), inject: [DB] },
        { provide: AuditRepository, useFactory: (db: Database.Database) => new AuditRepository(db), inject: [DB] },
        { provide: UsersRepository, useFactory: (db: Database.Database) => new UsersRepository(db), inject: [DB] },
        { provide: DnssecKeyRepository, useFactory: (db: Database.Database) => new DnssecKeyRepository(db), inject: [DB] },
        { provide: DynDnsRepository, useFactory: (db: Database.Database) => new DynDnsRepository(db), inject: [DB] },
        {
          provide: DynDnsService,
          useFactory: (r: DynDnsRepository, z: ZoneService, a: AuditRepository) => new DynDnsService(r, z, Date.now, a),
          inject: [DynDnsRepository, ZoneService, AuditRepository],
        },
        { provide: SettingsRepository, useFactory: (db: Database.Database) => new SettingsRepository(db), inject: [DB] },
        { provide: ZoneIndex, useValue: new ZoneIndex() },
        { provide: Stats, useValue: new Stats() },
        { provide: REPLICATION_IO, useValue: deps.io ?? realIO },
        {
          provide: Notifier,
          useFactory: (io: ReplicationIO) => new Notifier(cfg.notifyTo.map(parseTarget), io),
          inject: [REPLICATION_IO],
        },
        {
          provide: ZoneService,
          useFactory: (r: ZoneRepository, i: ZoneIndex, a: AuditRepository, n: Notifier, k: DnssecKeyRepository) =>
            new ZoneService(r, i, a, (zone) => n.schedule(zone), k),
          inject: [ZoneRepository, ZoneIndex, AuditRepository, Notifier, DnssecKeyRepository],
        },
        {
          provide: SecondaryManager,
          useFactory: (r: ZoneRepository, z: ZoneService, i: ZoneIndex, io: ReplicationIO) => new SecondaryManager(r, z, i, io),
          inject: [ZoneRepository, ZoneService, ZoneIndex, REPLICATION_IO],
        },
        UsersService,
        AuthService,
        Lifecycle,
        {
          provide: CLUSTER_TRANSPORT,
          useFactory: (): ClusterTransport | null => deps.clusterTransport ?? (cfg.clusterSecret ? new HttpClusterTransport(cfg.clusterSecret, cfg.clusterNodeId) : null),
        },
        {
          provide: CLUSTER,
          useFactory: (db: Database.Database, zones: ZoneService, audit: AuditRepository, transport: ClusterTransport | null): ClusterRuntime | null => {
            if (!cfg.clusterSecret || !transport) return null
            const peers = cfg.clusterPeers.map((p) => parsePeerAddress(p, cfg.apiPort))
            const service = new ClusterService(db, new ClusterStore(db), zones, transport, { nodeId: cfg.clusterNodeId, peers, syncSeconds: cfg.clusterSyncSeconds }, audit)
            return { service, gate: new PeerGate(cfg.clusterSecret, peers, cfg.clusterAllowFrom) }
          },
          inject: [DB, ZoneService, AuditRepository, CLUSTER_TRANSPORT],
        },
        { provide: APP_INTERCEPTOR, useClass: ClusterTouchInterceptor },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [ZoneIndex, Stats, SecondaryManager, CLUSTER],
    }
  }
}
