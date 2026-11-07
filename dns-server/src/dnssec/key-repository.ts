import type Database from 'better-sqlite3'
import type { DnssecKey } from './keys.js'

export interface StoredKey extends DnssecKey {
  id: number
  createdAt: string
}

interface Row {
  id: number
  algorithm: number
  flags: number
  private_key: string
  public_key: string
  key_tag: number
  active: number
  published: number
  created_at: string
}

const toKey = (r: Row): StoredKey => ({
  id: r.id,
  algorithm: r.algorithm,
  flags: r.flags,
  privateKeyPem: r.private_key,
  publicKey: Buffer.from(r.public_key, 'base64'),
  keyTag: r.key_tag,
  active: r.active === 1,
  published: r.published === 1,
  createdAt: r.created_at,
})

/** Signing keys per zone. The private keys live in the database, so it must be protected and backed up like one. */
export class DnssecKeyRepository {
  constructor(private readonly db: Database.Database) {}

  list(zoneId: number): StoredKey[] {
    return (this.db.prepare('SELECT * FROM dnssec_keys WHERE zone_id = ? ORDER BY id').all(zoneId) as Row[]).map(toKey)
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT zone_id) AS n FROM dnssec_keys').get() as { n: number }).n
  }

  insert(zoneId: number, k: Pick<DnssecKey, 'algorithm' | 'flags' | 'privateKeyPem' | 'publicKey' | 'keyTag' | 'active' | 'published'>): StoredKey {
    const info = this.db
      .prepare('INSERT INTO dnssec_keys (zone_id, algorithm, flags, private_key, public_key, key_tag, active, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(zoneId, k.algorithm, k.flags, k.privateKeyPem, k.publicKey.toString('base64'), k.keyTag, k.active ? 1 : 0, k.published ? 1 : 0)
    return toKey(this.db.prepare('SELECT * FROM dnssec_keys WHERE id = ?').get(Number(info.lastInsertRowid)) as Row)
  }

  update(id: number, patch: { active?: boolean; published?: boolean }): void {
    if (patch.active !== undefined) this.db.prepare('UPDATE dnssec_keys SET active = ? WHERE id = ?').run(patch.active ? 1 : 0, id)
    if (patch.published !== undefined) this.db.prepare('UPDATE dnssec_keys SET published = ? WHERE id = ?').run(patch.published ? 1 : 0, id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM dnssec_keys WHERE id = ?').run(id)
  }

  deleteAll(zoneId: number): void {
    this.db.prepare('DELETE FROM dnssec_keys WHERE zone_id = ?').run(zoneId)
  }
}
