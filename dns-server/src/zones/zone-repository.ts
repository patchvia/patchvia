import type Database from 'better-sqlite3'
import type { RTypeName } from '../dns/types.js'

export interface ZoneRow {
  id: number
  name: string
  kind: string
  accountId: number | null
  /** Primaries a secondary zone transfers from ("host" or "host:port"); empty for other kinds */
  masters: string[]
  lastCheck: string | null
  lastTransfer: string | null
  transferError: string | null
}

interface RawZoneRow extends Omit<ZoneRow, 'masters'> {
  masters: string | null
}

const toRow = (r: RawZoneRow): ZoneRow => ({ ...r, masters: r.masters ? (JSON.parse(r.masters) as string[]) : [] })

export interface StoredRecord {
  content: string
  disabled: boolean
}

export interface StoredRRset {
  name: string
  type: RTypeName
  ttl: number
  records: StoredRecord[]
}

const ZONE_COLS =
  'id, name, kind, account_id AS accountId, masters, last_check AS lastCheck, last_transfer AS lastTransfer, transfer_error AS transferError'

/** All SQL for zones lives here so the store can be swapped. */
export class ZoneRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  listZones(): ZoneRow[] {
    return (this.db.prepare(`SELECT ${ZONE_COLS} FROM zones ORDER BY name`).all() as RawZoneRow[]).map(toRow)
  }

  getZone(name: string): ZoneRow | undefined {
    const row = this.db.prepare(`SELECT ${ZONE_COLS} FROM zones WHERE name = ?`).get(name) as RawZoneRow | undefined
    return row && toRow(row)
  }

  insertZone(name: string, kind: string, accountId: number | null = null, masters: string[] = []): ZoneRow {
    const info = this.db
      .prepare('INSERT INTO zones (name, kind, account_id, masters) VALUES (?, ?, ?, ?)')
      .run(name, kind, accountId, masters.length ? JSON.stringify(masters) : null)
    return this.getZoneById(Number(info.lastInsertRowid))!
  }

  private getZoneById(id: number): ZoneRow | undefined {
    const row = this.db.prepare(`SELECT ${ZONE_COLS} FROM zones WHERE id = ?`).get(id) as RawZoneRow | undefined
    return row && toRow(row)
  }

  setKind(id: number, kind: string): void {
    this.db.prepare('UPDATE zones SET kind = ? WHERE id = ?').run(kind, id)
  }

  setMasters(id: number, masters: string[]): void {
    this.db.prepare('UPDATE zones SET masters = ? WHERE id = ?').run(masters.length ? JSON.stringify(masters) : null, id)
  }

  /** Records the outcome of contacting a primary. A transfer clears the error; a failure keeps the last good time. */
  recordCheck(id: number, result: { transferred?: boolean; error?: string | null }): void {
    this.db
      .prepare(
        `UPDATE zones SET last_check = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           last_transfer = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_transfer END,
           transfer_error = ? WHERE id = ?`,
      )
      .run(result.transferred ? 1 : 0, result.error ?? null, id)
  }

  /** Replaces every RRset of a zone (used by transfers and imports). Call inside a transaction. */
  replaceAll(zoneId: number, sets: StoredRRset[]): void {
    this.db.prepare('DELETE FROM rrsets WHERE zone_id = ?').run(zoneId)
    const insSet = this.db.prepare('INSERT INTO rrsets (zone_id, name, type, ttl) VALUES (?, ?, ?, ?)')
    const insRec = this.db.prepare('INSERT INTO records (rrset_id, content, disabled) VALUES (?, ?, ?)')
    for (const s of sets) {
      const info = insSet.run(zoneId, s.name, s.type, s.ttl)
      for (const r of s.records) insRec.run(info.lastInsertRowid, r.content, r.disabled ? 1 : 0)
    }
  }

  setZoneAccount(id: number, accountId: number | null): void {
    this.db.prepare('UPDATE zones SET account_id = ? WHERE id = ?').run(accountId, id)
  }

  deleteZone(id: number): void {
    this.db.prepare('DELETE FROM zones WHERE id = ?').run(id)
  }

  getRRsets(zoneId: number): StoredRRset[] {
    const sets = this.db.prepare('SELECT id, name, type, ttl FROM rrsets WHERE zone_id = ? ORDER BY name, type').all(zoneId) as SetRow[]
    return sets.map((s) => this.hydrate(s))
  }

  getRRset(zoneId: number, name: string, type: RTypeName): StoredRRset | undefined {
    const row = this.db.prepare('SELECT id, name, type, ttl FROM rrsets WHERE zone_id = ? AND name = ? AND type = ?').get(zoneId, name, type) as
      | SetRow
      | undefined
    return row && this.hydrate(row)
  }

  typesAt(zoneId: number, name: string): RTypeName[] {
    return (this.db.prepare('SELECT type FROM rrsets WHERE zone_id = ? AND name = ?').all(zoneId, name) as { type: RTypeName }[]).map((r) => r.type)
  }

  replaceRRset(zoneId: number, name: string, type: RTypeName, ttl: number, records: StoredRecord[]): void {
    this.transaction(() => {
      this.deleteRRset(zoneId, name, type)
      const info = this.db.prepare('INSERT INTO rrsets (zone_id, name, type, ttl) VALUES (?, ?, ?, ?)').run(zoneId, name, type, ttl)
      const ins = this.db.prepare('INSERT INTO records (rrset_id, content, disabled) VALUES (?, ?, ?)')
      for (const r of records) ins.run(info.lastInsertRowid, r.content, r.disabled ? 1 : 0)
    })
  }

  deleteRRset(zoneId: number, name: string, type: RTypeName): boolean {
    return this.db.prepare('DELETE FROM rrsets WHERE zone_id = ? AND name = ? AND type = ?').run(zoneId, name, type).changes > 0
  }

  private hydrate(s: SetRow): StoredRRset {
    const recs = this.db.prepare('SELECT content, disabled FROM records WHERE rrset_id = ? ORDER BY id').all(s.id) as {
      content: string
      disabled: number
    }[]
    return { name: s.name, type: s.type, ttl: s.ttl, records: recs.map((r) => ({ content: r.content, disabled: r.disabled === 1 })) }
  }
}

interface SetRow {
  id: number
  name: string
  type: RTypeName
  ttl: number
}
