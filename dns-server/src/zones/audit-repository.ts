import type Database from 'better-sqlite3'

export interface AuditEntry {
  id: number
  at: string
  actor: string
  zone: string | null
  action: string
  detail: unknown
}

export interface AuditInput {
  actor: string
  zone?: string | null
  action: string
  detail?: unknown
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  insert(e: AuditInput): void {
    this.db
      .prepare('INSERT INTO audit (actor, zone, action, detail) VALUES (?, ?, ?, ?)')
      .run(e.actor, e.zone ?? null, e.action, JSON.stringify(e.detail ?? {}))
  }

  /** Newest first. `before` is an audit id for keyset paging. */
  list(opts: { zone?: string; limit?: number; before?: number } = {}): AuditEntry[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.zone !== undefined) (where.push('zone = ?'), args.push(opts.zone))
    if (opts.before !== undefined) (where.push('id < ?'), args.push(opts.before))
    const sql = `SELECT id, at, actor, zone, action, detail FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 50, 500)) as (Omit<AuditEntry, 'detail'> & { detail: string })[]
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown }))
  }
}
