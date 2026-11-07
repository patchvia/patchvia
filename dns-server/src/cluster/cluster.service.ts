import { Logger } from '@nestjs/common'
import type Database from 'better-sqlite3'
import type { AuditRepository } from '../zones/audit-repository.js'
import type { ZoneService } from '../zones/zone-service.js'
import { ENTITY_KINDS, TOMBSTONE_PAYLOAD, canonical, isBulk, kindOf, zoneOf, type WireEntity } from './entities.js'
import { HlcClock, compareHlc } from './hlc.js'
import type { PeerAddress } from './peer-address.js'
import { bumpLocalSerial, reconcile } from './reconcile.js'
import { buildSnapshot, type SnapshotScope } from './snapshot.js'
import type { ClusterStore } from './store.js'

export interface ChangesResponse {
  nodeId: string
  /** Highest sequence number this node has. If it is lower than what we last saw, the node was restored from a backup. */
  maxSeq: number
  entities: WireEntity[]
  more: boolean
}

/** How nodes talk to each other. HTTP in production, direct calls in tests. */
export interface ClusterTransport {
  changes(peer: PeerAddress, since: number, limit: number): Promise<ChangesResponse>
  /** Tells a peer there is something new, so it pulls now instead of at its next interval. */
  nudge(peer: PeerAddress): Promise<void>
}

export interface ClusterOptions {
  nodeId: string
  peers: PeerAddress[]
  syncSeconds: number
  now?: () => number
  pageSize?: number
}

export interface MergeSummary {
  received: number
  applied: number
  rejected: number
  zones: string[]
}

export interface PeerResult {
  peer: string
  ok: boolean
  merged: number
  error?: string
}

const SMALL_ONLY: SnapshotScope = { small: true, zones: new Set() }
const MAX_PAYLOAD = 2_000_000
const KEY_PATTERN = /^[a-z]+:[^\u0000]{1,600}$/

/**
 * Multi-master zone replication. Every node keeps serving and accepting changes on its own; changes are stamped with a
 * hybrid logical clock and merged last-writer-wins per item, so nodes converge whatever order changes arrive in and
 * whichever of them could reach which. Nodes pull "everything since N" from each peer (and relay what they got from
 * others), and a nudge after a local change makes that happen straight away rather than at the next interval.
 */
export class ClusterService {
  private readonly log = new Logger('Cluster')
  readonly clock: HlcClock
  private readonly dirtyZones = new Set<string>()
  private captureTimer?: NodeJS.Timeout
  private syncTimer?: NodeJS.Timeout
  private nudgeTimer?: NodeJS.Timeout
  private syncing?: Promise<PeerResult[]>
  private lastFullCapture = 0
  private readonly now: () => number
  private readonly pageSize: number

  constructor(
    private readonly db: Database.Database,
    private readonly store: ClusterStore,
    private readonly zones: ZoneService,
    private readonly transport: ClusterTransport,
    private readonly opts: ClusterOptions,
    private readonly audit?: AuditRepository,
  ) {
    this.now = opts.now ?? Date.now
    this.pageSize = opts.pageSize ?? 500
    const saved = (db.prepare("SELECT value FROM settings WHERE key = 'cluster.hlc'").get() as { value: string } | undefined)?.value
    this.clock = new HlcClock(opts.nodeId, this.now, saved)
  }

  get nodeId(): string {
    return this.opts.nodeId
  }

  get peers(): PeerAddress[] {
    return this.opts.peers
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  /** Starts noticing zone changes. `start()` calls this; tests that drive syncing by hand call it alone. */
  attach(): void {
    this.zones.setHooks({ zoneTouched: (z) => this.zoneTouched(z) })
  }

  start(): void {
    this.stop()
    this.attach()
    // Adopt whatever is already in this node's database, then start talking
    this.safely(() => this.capture({ small: true, zones: 'all' }))
    void this.syncAll()
    this.syncTimer = setInterval(() => void this.syncAll(), this.opts.syncSeconds * 1000)
    this.syncTimer.unref()
  }

  stop(): void {
    this.safely(() => this.persistClock())
    clearInterval(this.syncTimer)
    clearTimeout(this.captureTimer)
    clearTimeout(this.nudgeTimer)
    this.syncTimer = this.captureTimer = this.nudgeTimer = undefined
  }

  // ---- local changes -----------------------------------------------------------------------------------------------

  zoneTouched(zone: string): void {
    this.dirtyZones.add(zone)
    this.scheduleCapture()
  }

  /** Something outside the zones (a user, a key, a token) changed. */
  smallTouched(): void {
    this.scheduleCapture()
  }

  private scheduleCapture(): void {
    if (this.captureTimer) return
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined
      const n = this.safely(() => this.capture())
      if (n) this.nudgePeers()
    }, 100)
    this.captureTimer.unref()
  }

  /**
   * Records changes made on this node: anything in the live data that differs from what was last replicated gets a new
   * stamp, and anything this node had applied that is now gone gets a tombstone. Returns how many entities changed.
   */
  capture(scope?: SnapshotScope): number {
    const dirty = new Set(this.dirtyZones)
    this.dirtyZones.clear()
    const periodicFull = this.now() - this.lastFullCapture > 5 * 60_000
    const s: SnapshotScope = scope ?? { small: true, zones: periodicFull ? 'all' : dirty }
    if (s.zones === 'all') this.lastFullCapture = this.now()
    return this.store.transaction(() => {
      const snap = buildSnapshot(this.db, s)
      let changed = 0
      for (const e of snap.values()) {
        const cur = this.store.get(e.key)
        if (!cur || cur.deleted || cur.hash !== e.hash) {
          this.store.put({ key: e.key, hlc: this.clock.tick(), deleted: false, payload: e.json, live: true })
          changed++
        } else if (!cur.live) this.store.setLive(e.key, true)
      }
      const prefixes: string[] = []
      if (s.small) prefixes.push(...ENTITY_KINDS.filter((k) => k !== 'rrset').map((k) => `${k}:`))
      if (s.zones === 'all') prefixes.push('rrset:')
      else prefixes.push(...[...s.zones].map((z) => `rrset:${z}|`))
      for (const e of this.store.withPrefixes(prefixes)) {
        // Only what this node had applied can be deleted by this node: an entity still waiting for its parent is not "gone"
        if (!e.deleted && e.live && !snap.has(e.key)) {
          this.store.put({ key: e.key, hlc: this.clock.tick(), deleted: true, payload: TOMBSTONE_PAYLOAD, live: false })
          changed++
        }
      }
      if (changed) this.persistClock()
      return changed
    })
  }

  // ---- serving peers -----------------------------------------------------------------------------------------------

  /** A peer asks for everything after `since`. Local changes are captured first so it never misses one. */
  handleChanges(since: number, limit: number): ChangesResponse {
    this.capture()
    const rows = this.store.changesSince(since, limit + 1)
    const more = rows.length > limit
    return { nodeId: this.opts.nodeId, maxSeq: this.store.maxSeq(), entities: rows.slice(0, limit), more }
  }

  /** A peer says it has something new: pull soon (debounced, so a burst of nudges is one sync). */
  handleNudge(): void {
    if (this.nudgeTimer) return
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined
      void this.syncAll()
    }, 50)
    this.nudgeTimer.unref()
  }

  private nudgePeers(): void {
    for (const p of this.opts.peers) void this.transport.nudge(p).catch(() => undefined)
  }

  // ---- pulling from peers ------------------------------------------------------------------------------------------

  /** Pulls from every peer now. Overlapping calls share one run. */
  syncAll(): Promise<PeerResult[]> {
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      this.safely(() => this.capture())
      const results = await Promise.all(this.opts.peers.map((p) => this.pullFrom(p)))
      return results
    })().finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }

  async pullFrom(peer: PeerAddress): Promise<PeerResult> {
    let since = this.store.peer(peer.label)?.lastSeq ?? 0
    let merged = 0
    let resetOnce = false
    try {
      for (;;) {
        const r = await this.transport.changes(peer, since, this.pageSize)
        if (r.nodeId === this.opts.nodeId) throw new Error('that address is this node, or two nodes share a CLUSTER_NODE_ID')
        if (r.maxSeq < since && !resetOnce) {
          // The peer's log is behind what we had from it: it was restored from a backup. Start over; merging is idempotent.
          this.log.warn(`${peer.label} (${r.nodeId}) went backwards (${r.maxSeq} < ${since}); resynchronising from the start`)
          since = 0
          resetOnce = true
          continue
        }
        const m = this.merge(r.nodeId, r.entities)
        merged += m.applied
        if (r.entities.length) since = r.entities[r.entities.length - 1]!.seq
        this.store.recordPeer(peer.label, { nodeId: r.nodeId, lastSeq: since, contact: true })
        if (!r.more) break
      }
      return { peer: peer.label, ok: true, merged }
    } catch (e) {
      const message = (e as Error).message
      this.store.recordPeer(peer.label, { error: message })
      return { peer: peer.label, ok: false, merged, error: message }
    }
  }

  // ---- merging -----------------------------------------------------------------------------------------------------

  /**
   * Takes entities from a peer: newer ones replace ours (last writer wins), then the live tables are brought in line.
   * Safe to repeat, and safe in any order.
   */
  merge(from: string, incoming: WireEntity[]): MergeSummary {
    const valid: WireEntity[] = []
    let rejected = 0
    for (const e of incoming) {
      if (!this.plausible(e)) {
        rejected++
        continue
      }
      valid.push(e)
    }
    const touchedZones = new Set<string>()
    let small = false
    for (const e of valid) {
      if (isBulk(e.key)) touchedZones.add(zoneOf(e.key)!)
      else {
        small = true
        const z = zoneOf(e.key)
        if (z) touchedZones.add(z)
      }
    }

    const result = this.store.transaction(() => {
      // Our own pending changes must be in the store before reconcile overwrites live data from it
      this.capture({ small: true, zones: new Set([...touchedZones, ...this.dirtyZones]) })
      const existedBefore = new Set([...touchedZones].filter((z) => (this.db.prepare('SELECT 1 FROM zones WHERE name = ?').get(z) ? true : false)))
      let won = 0
      for (const e of valid) {
        this.clock.observe(e.hlc)
        const cur = this.store.get(e.key)
        if (cur && compareHlc(e.hlc, cur.hlc) <= 0) continue
        this.store.put({ key: e.key, hlc: e.hlc, deleted: e.deleted, payload: e.deleted ? TOMBSTONE_PAYLOAD : e.payload, live: false })
        won++
      }
      if (won === 0) return { won: 0, res: undefined, existedBefore }
      const res = reconcile(this.db, this.store, { small, zones: touchedZones })
      for (const z of res.contentChanged) if (existedBefore.has(z)) bumpLocalSerial(this.db, z, new Date(this.now()))
      for (const z of res.contentChanged) this.audit?.insert({ actor: `cluster:${from}`, zone: z, action: 'cluster.sync', detail: { from } })
      this.persistClock()
      return { won, res, existedBefore }
    })

    const zonesChanged: string[] = []
    if (result.res) {
      for (const sk of result.res.skipped) {
        if (sk.reason !== 'secondary' && !sk.reason.startsWith('waiting')) this.log.warn(`skipped ${sk.key}: ${sk.reason}`)
      }
      for (const z of result.res.deleted) this.zones.dropZone(z)
      for (const z of new Set([...result.res.contentChanged, ...result.res.otherChanged])) {
        if (result.res.deleted.has(z)) continue
        const r = this.zones.reloadZone(z)
        if (!r.ok) this.log.warn(`${z}: not rebuilt yet (${r.error}); the previous version keeps serving`)
        zonesChanged.push(z)
      }
    }
    return { received: incoming.length, applied: result.won, rejected, zones: zonesChanged }
  }

  private plausible(e: WireEntity): boolean {
    if (typeof e.key !== 'string' || !KEY_PATTERN.test(e.key) || !kindOf(e.key)) return false
    if (typeof e.hlc !== 'string' || this.clock.isImplausible(e.hlc)) {
      this.log.warn(`ignoring ${e.key}: its timestamp is missing or more than a day ahead (check that node's clock)`)
      return false
    }
    if (typeof e.payload !== 'string' || e.payload.length > MAX_PAYLOAD) return false
    if (!e.deleted) {
      try {
        if (canonical(JSON.parse(e.payload)) !== e.payload) return false // must already be canonical, or hashes would differ between nodes
      } catch {
        return false
      }
    }
    return true
  }

  // ---- status ------------------------------------------------------------------------------------------------------

  status() {
    const counts = this.store.counts()
    return {
      nodeId: this.opts.nodeId,
      hlc: this.clock.last(),
      entities: counts.total - counts.tombstones,
      tombstones: counts.tombstones,
      seq: this.store.maxSeq(),
      peers: this.opts.peers.map((p) => {
        const row = this.store.peer(p.label)
        return {
          address: p.label,
          nodeId: row?.nodeId ?? null,
          lastContact: row?.lastContact ?? null,
          lastError: row?.lastError ?? null,
          lastSeq: row?.lastSeq ?? 0,
        }
      }),
    }
  }

  // ---- helpers -----------------------------------------------------------------------------------------------------

  private persistClock(): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('cluster.hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.clock.last())
  }

  private safely<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch (e) {
      this.log.error(`${(e as Error).message}`)
      return undefined
    }
  }
}
