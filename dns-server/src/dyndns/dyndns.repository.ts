import type Database from 'better-sqlite3'

export interface DynToken {
  id: number
  zoneId: number
  name: string
  ttl: number
  prefix: string
  lastIp4: string | null
  lastIp6: string | null
  lastUsedAt: string | null
  createdAt: string
}

const COLS = 'id, zone_id AS zoneId, name, ttl, prefix, last_ip4 AS lastIp4, last_ip6 AS lastIp6, last_used_at AS lastUsedAt, created_at AS createdAt'

export class DynDnsRepository {
  constructor(private readonly db: Database.Database) {}

  list(zoneId: number): DynToken[] {
    return this.db.prepare(`SELECT ${COLS} FROM dyndns_tokens WHERE zone_id = ? ORDER BY name`).all(zoneId) as DynToken[]
  }

  get(id: number): DynToken | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM dyndns_tokens WHERE id = ?`).get(id) as DynToken | undefined
  }

  byHash(hash: string): (DynToken & { zoneName: string; zoneKind: string }) | undefined {
    return this.db
      .prepare(
        `SELECT t.id, t.zone_id AS zoneId, t.name, t.ttl, t.prefix, t.last_ip4 AS lastIp4, t.last_ip6 AS lastIp6,
                t.last_used_at AS lastUsedAt, t.created_at AS createdAt, z.name AS zoneName, z.kind AS zoneKind
         FROM dyndns_tokens t JOIN zones z ON z.id = t.zone_id WHERE t.token_hash = ?`,
      )
      .get(hash) as (DynToken & { zoneName: string; zoneKind: string }) | undefined
  }

  insert(t: { zoneId: number; name: string; ttl: number; prefix: string; hash: string }): DynToken {
    const info = this.db.prepare('INSERT INTO dyndns_tokens (zone_id, name, ttl, prefix, token_hash) VALUES (?, ?, ?, ?, ?)').run(t.zoneId, t.name, t.ttl, t.prefix, t.hash)
    return this.get(Number(info.lastInsertRowid))!
  }

  setTtl(id: number, ttl: number): void {
    this.db.prepare('UPDATE dyndns_tokens SET ttl = ? WHERE id = ?').run(ttl, id)
  }

  touch(id: number, ips: { ip4?: string; ip6?: string }): void {
    this.db
      .prepare(
        `UPDATE dyndns_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           last_ip4 = COALESCE(?, last_ip4), last_ip6 = COALESCE(?, last_ip6) WHERE id = ?`,
      )
      .run(ips.ip4 ?? null, ips.ip6 ?? null, id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM dyndns_tokens WHERE id = ?').run(id)
  }
}
