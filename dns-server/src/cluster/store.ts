import type Database from 'better-sqlite3'
import { hashOf, kindOf, type EntityKind, type StoredEntity, type WireEntity } from './entities.js'

interface Row {
  key: string
  kind: EntityKind
  hlc: string
  deleted: number
  payload: string
  hash: string
  seq: number
  live: number
}

const toEntity = (r: Row): StoredEntity => ({ key: r.key, kind: r.kind, hlc: r.hlc, deleted: r.deleted === 1, payload: r.payload, hash: r.hash, seq: r.seq, live: r.live === 1 })

export interface PeerRow {
  address: string
  nodeId: string | null
  lastSeq: number
  lastContact: string | null
  lastError: string | null
}

/** The replication log: one row per entity (latest version only), numbered with a local, monotonic `seq` so peers can ask for "everything since N". */
export class ClusterStore {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  get(key: string): StoredEntity | undefined {
    const r = this.db.prepare('SELECT * FROM cluster_entities WHERE key = ?').get(key) as Row | undefined
    return r && toEntity(r)
  }

  maxSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM cluster_entities').get() as { m: number }).m
  }

  /** Writes (or replaces) an entity and gives it the next local sequence number. */
  put(e: { key: string; hlc: string; deleted: boolean; payload: string; live: boolean }): void {
    const kind = kindOf(e.key)
    if (!kind) throw new Error(`unknown entity key ${e.key}`)
    this.db
      .prepare(
        `INSERT INTO cluster_entities (key, kind, hlc, deleted, payload, hash, seq, live)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM cluster_entities), ?)
         ON CONFLICT(key) DO UPDATE SET hlc = excluded.hlc, deleted = excluded.deleted, payload = excluded.payload,
           hash = excluded.hash, seq = excluded.seq, live = excluded.live`,
      )
      .run(e.key, kind, e.hlc, e.deleted ? 1 : 0, e.payload, hashOf(e.payload), e.live ? 1 : 0)
  }

  setLive(key: string, live: boolean): void {
    this.db.prepare('UPDATE cluster_entities SET live = ? WHERE key = ?').run(live ? 1 : 0, key)
  }

  /** Entities changed after `since`, oldest first. Includes tombstones: a deletion has to reach every node. */
  changesSince(since: number, limit: number): WireEntity[] {
    return (this.db.prepare('SELECT key, hlc, deleted, payload, seq FROM cluster_entities WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit) as Omit<Row, 'kind' | 'hash' | 'live'>[]).map((r) => ({
      key: r.key,
      hlc: r.hlc,
      deleted: r.deleted === 1,
      payload: r.payload,
      seq: r.seq,
    }))
  }

  /** Every non-deleted entity of the given kinds. */
  alive(kinds: EntityKind[]): StoredEntity[] {
    const q = `SELECT * FROM cluster_entities WHERE deleted = 0 AND kind IN (${kinds.map(() => '?').join(',')})`
    return (this.db.prepare(q).all(...kinds) as Row[]).map(toEntity)
  }

  /** Entities (any state) whose key starts with one of the prefixes. */
  withPrefixes(prefixes: string[]): StoredEntity[] {
    const out: StoredEntity[] = []
    const stmt = this.db.prepare('SELECT * FROM cluster_entities WHERE key >= ? AND key < ?')
    for (const p of prefixes) out.push(...(stmt.all(p, p + '￿') as Row[]).map(toEntity))
    return out
  }

  counts(): { total: number; tombstones: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(deleted), 0) AS tombstones FROM cluster_entities').get() as { total: number; tombstones: number }
    return r
  }

  // ---- peers ----

  peer(address: string): PeerRow | undefined {
    return this.db.prepare('SELECT address, node_id AS nodeId, last_seq AS lastSeq, last_contact AS lastContact, last_error AS lastError FROM cluster_peers WHERE address = ?').get(address) as PeerRow | undefined
  }

  peers(): PeerRow[] {
    return this.db.prepare('SELECT address, node_id AS nodeId, last_seq AS lastSeq, last_contact AS lastContact, last_error AS lastError FROM cluster_peers ORDER BY address').all() as PeerRow[]
  }

  recordPeer(address: string, patch: { nodeId?: string; lastSeq?: number; contact?: boolean; error?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO cluster_peers (address, node_id, last_seq, last_contact, last_error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           node_id = COALESCE(?, node_id),
           last_seq = COALESCE(?, last_seq),
           last_contact = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_contact END,
           last_error = CASE WHEN ? THEN ? ELSE last_error END`,
      )
      .run(
        address,
        patch.nodeId ?? null,
        patch.lastSeq ?? 0,
        patch.contact ? new Date().toISOString() : null,
        patch.error ?? null,
        patch.nodeId ?? null,
        patch.lastSeq ?? null,
        patch.contact ? 1 : 0,
        patch.error !== undefined || patch.contact ? 1 : 0,
        patch.error ?? null,
      )
  }
}
