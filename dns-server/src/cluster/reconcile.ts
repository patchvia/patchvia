import type Database from 'better-sqlite3'
import { compileRRset } from '../zones/zone.js'
import { nextSerial } from '../zones/serial.js'
import type { RTypeName } from '../dns/types.js'
import { isBulk, kindOf, withSoaSerial, zoneOf, type StoredEntity } from './entities.js'
import type { ClusterStore } from './store.js'
import { buildSnapshot, type SnapshotScope } from './snapshot.js'

export interface ReconcileResult {
  /** Zones whose records changed (so their SOA serial moved and they need recompiling) */
  contentChanged: Set<string>
  /** Zones whose keys, tokens or properties changed (recompile, no serial bump) */
  otherChanged: Set<string>
  deleted: Set<string>
  /** Entities skipped because they did not validate or their parent has not arrived yet */
  skipped: { key: string; reason: string }[]
  applied: number
}

type Payload = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const ORDER = ['account', 'user', 'zone', 'rrset', 'ddns', 'dnssec', 'apikey'] as const

/**
 * Makes the live tables match the replication store, for the given scope. Run right after `capture`, so anything this
 * node changed locally is already in the store and cannot be overwritten. Idempotent: running it twice changes nothing,
 * and what it writes snapshots back to exactly the payloads it read (otherwise nodes would keep re-sending each other's changes).
 */
export function reconcile(db: Database.Database, store: ClusterStore, scope: SnapshotScope): ReconcileResult {
  const res: ReconcileResult = { contentChanged: new Set(), otherChanged: new Set(), deleted: new Set(), skipped: [], applied: 0 }
  const live = buildSnapshot(db, scope)

  const inScope = (e: StoredEntity): boolean => {
    if (!isBulk(e.key)) return scope.small
    const z = zoneOf(e.key)!
    return scope.zones === 'all' || scope.zones.has(z)
  }

  const small = scope.small ? (['account', 'user', 'zone', 'ddns', 'dnssec', 'apikey'] as const) : []
  const loaded: StoredEntity[] = [...store.alive([...small]), ...store.withPrefixes(small.map((k) => `${k}:`)).filter((e) => e.deleted)]
  // The records are the bulk: load only the zones in scope, never the whole table
  if (scope.zones === 'all') {
    loaded.push(...store.alive(['rrset']), ...store.withPrefixes(['rrset:']).filter((e) => e.deleted))
  } else if (scope.zones.size > 0) {
    loaded.push(...store.withPrefixes([...scope.zones].map((z) => `rrset:${z}|`)))
  }
  const entities = loaded
    .filter(inScope)
    .sort((a, b) => ORDER.indexOf(a.kind as (typeof ORDER)[number]) - ORDER.indexOf(b.kind as (typeof ORDER)[number]))

  for (const e of entities) {
    const mine = live.get(e.key)
    if (e.deleted) {
      if (mine) {
        remove(db, e, res)
        res.applied++
      }
      continue
    }
    if (mine && mine.hash === e.hash) {
      if (!e.live) store.setLive(e.key, true)
      continue
    }
    const outcome = upsert(db, e, res)
    if (outcome === 'ok') {
      res.applied++
      store.setLive(e.key, true)
    } else {
      store.setLive(e.key, false)
      res.skipped.push({ key: e.key, reason: outcome })
    }
  }
  return res
}

// ---- writes ----------------------------------------------------------------------------------------------------------

const id = (db: Database.Database, sql: string, ...args: unknown[]): number | undefined => (db.prepare(sql).get(...args) as { id: number } | undefined)?.id

function remove(db: Database.Database, e: StoredEntity, res: ReconcileResult): void {
  const rest = e.key.slice(e.key.indexOf(':') + 1)
  switch (e.kind) {
    case 'account':
      db.prepare('DELETE FROM accounts WHERE name = ?').run(rest)
      break
    case 'user':
      db.prepare('DELETE FROM users WHERE username = ?').run(rest)
      break
    case 'apikey':
      db.prepare('DELETE FROM api_keys WHERE hash = ?').run(rest)
      break
    case 'zone':
      db.prepare('DELETE FROM zones WHERE name = ?').run(rest)
      res.deleted.add(rest)
      break
    case 'rrset': {
      const [zone, name, type] = rest.split('|') as [string, string, string]
      const zid = id(db, 'SELECT id FROM zones WHERE name = ?', zone)
      if (zid !== undefined && type !== 'SOA') {
        db.prepare('DELETE FROM rrsets WHERE zone_id = ? AND name = ? AND type = ?').run(zid, name, type)
        res.contentChanged.add(zone)
      }
      break
    }
    case 'ddns': {
      const [zone, name] = rest.split('|') as [string, string]
      db.prepare('DELETE FROM dyndns_tokens WHERE name = ? AND zone_id = (SELECT id FROM zones WHERE name = ?)').run(name, zone)
      res.otherChanged.add(zone)
      break
    }
    case 'dnssec': {
      const [zone, tag] = rest.split('|') as [string, string]
      db.prepare('DELETE FROM dnssec_keys WHERE key_tag = ? AND zone_id = (SELECT id FROM zones WHERE name = ?)').run(Number(tag), zone)
      res.otherChanged.add(zone)
      break
    }
  }
}

function upsert(db: Database.Database, e: StoredEntity, res: ReconcileResult): 'ok' | string {
  let p: Payload
  try {
    p = JSON.parse(e.payload) as Payload
  } catch {
    return 'payload is not JSON'
  }
  const rest = e.key.slice(e.key.indexOf(':') + 1)
  switch (e.kind) {
    case 'account': {
      db.prepare('INSERT INTO accounts (name, description) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description').run(rest, String(p.description ?? ''))
      return 'ok'
    }
    case 'user': {
      if (!['admin', 'operator', 'user'].includes(p.role)) return 'unknown role'
      db.prepare(
        `INSERT INTO users (username, password_hash, role, token_version) VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, token_version = excluded.token_version`,
      ).run(rest, String(p.passwordHash), p.role, Number(p.tokenVersion ?? 0))
      const uid = id(db, 'SELECT id FROM users WHERE username = ?', rest)!
      db.prepare('DELETE FROM user_accounts WHERE user_id = ?').run(uid)
      for (const name of (p.accounts ?? []) as string[]) {
        const aid = id(db, 'SELECT id FROM accounts WHERE name = ?', name)
        if (aid !== undefined) db.prepare('INSERT OR IGNORE INTO user_accounts (user_id, account_id) VALUES (?, ?)').run(uid, aid)
      }
      return linksComplete(db, uid, p.accounts ?? []) ? 'ok' : 'waiting for an account'
    }
    case 'apikey': {
      const uid = id(db, 'SELECT id FROM users WHERE username = ?', String(p.user))
      if (uid === undefined) return 'waiting for its user'
      db.prepare(
        `INSERT INTO api_keys (user_id, name, prefix, hash, scope) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, prefix = excluded.prefix, scope = excluded.scope`,
      ).run(uid, String(p.name), String(p.prefix), rest, p.scope === 'write' ? 'write' : 'read')
      return 'ok'
    }
    case 'zone': {
      if (!['native', 'master', 'slave'].includes(p.kind)) return 'unknown zone kind'
      const aid = p.account ? id(db, 'SELECT id FROM accounts WHERE name = ?', String(p.account)) : undefined
      const masters = (p.masters as string[]).length ? JSON.stringify(p.masters) : null
      const existing = id(db, 'SELECT id FROM zones WHERE name = ?', rest)
      if (existing === undefined) {
        db.prepare('INSERT INTO zones (name, kind, account_id, masters) VALUES (?, ?, ?, ?)').run(rest, p.kind, aid ?? null, masters)
      } else {
        db.prepare('UPDATE zones SET kind = ?, account_id = ?, masters = ? WHERE id = ?').run(p.kind, aid ?? null, masters, existing)
      }
      res.otherChanged.add(rest)
      return p.account && aid === undefined ? 'waiting for an account' : 'ok'
    }
    case 'rrset': {
      const [zone, name, type] = rest.split('|') as [string, string, RTypeName]
      const z = db.prepare('SELECT id, kind FROM zones WHERE name = ?').get(zone) as { id: number; kind: string } | undefined
      if (!z) return 'waiting for its zone'
      if (z.kind === 'slave') return 'secondary' // transferred locally, never replicated, so never counted as applied
      const records = p.records as { c: string; d: boolean }[]
      try {
        compileRRset(zone, { name, type, ttl: Number(p.ttl), contents: records.map((r) => r.c) })
      } catch (err) {
        return `invalid record set: ${(err as Error).message}`
      }
      const contents = type === 'SOA' ? records.map((r) => ({ ...r, c: withSoaSerial(r.c, localSerial(db, z.id, zone) ?? nextSerial(0)) })) : records
      db.prepare('DELETE FROM rrsets WHERE zone_id = ? AND name = ? AND type = ?').run(z.id, name, type)
      const info = db.prepare('INSERT INTO rrsets (zone_id, name, type, ttl) VALUES (?, ?, ?, ?)').run(z.id, name, type, Number(p.ttl))
      const ins = db.prepare('INSERT INTO records (rrset_id, content, disabled) VALUES (?, ?, ?)')
      for (const r of contents) ins.run(info.lastInsertRowid, r.c, r.d ? 1 : 0)
      res.contentChanged.add(zone)
      return 'ok'
    }
    case 'ddns': {
      const [zone, name] = rest.split('|') as [string, string]
      const zid = id(db, 'SELECT id FROM zones WHERE name = ?', zone)
      if (zid === undefined) return 'waiting for its zone'
      db.prepare(
        `INSERT INTO dyndns_tokens (zone_id, name, ttl, prefix, token_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(zone_id, name) DO UPDATE SET ttl = excluded.ttl, prefix = excluded.prefix, token_hash = excluded.token_hash`,
      ).run(zid, name, Number(p.ttl), String(p.prefix), String(p.hash))
      res.otherChanged.add(zone)
      return 'ok'
    }
    case 'dnssec': {
      const [zone, tag] = rest.split('|') as [string, string]
      const zid = id(db, 'SELECT id FROM zones WHERE name = ?', zone)
      if (zid === undefined) return 'waiting for its zone'
      const existing = id(db, 'SELECT id FROM dnssec_keys WHERE zone_id = ? AND key_tag = ?', zid, Number(tag))
      if (existing === undefined) {
        db.prepare('INSERT INTO dnssec_keys (zone_id, algorithm, flags, private_key, public_key, key_tag, active, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          zid, p.algorithm, p.flags, p.privateKeyPem, p.publicKey, Number(tag), p.active ? 1 : 0, p.published ? 1 : 0,
        )
      } else {
        db.prepare('UPDATE dnssec_keys SET algorithm = ?, flags = ?, private_key = ?, public_key = ?, active = ?, published = ? WHERE id = ?').run(
          p.algorithm, p.flags, p.privateKeyPem, p.publicKey, p.active ? 1 : 0, p.published ? 1 : 0, existing,
        )
      }
      res.otherChanged.add(zone)
      return 'ok'
    }
  }
  return `unknown kind ${kindOf(e.key)}`
}

function localSerial(db: Database.Database, zoneId: number, zone: string): number | undefined {
  const r = db
    .prepare("SELECT r.content FROM records r JOIN rrsets s ON s.id = r.rrset_id WHERE s.zone_id = ? AND s.name = ? AND s.type = 'SOA' LIMIT 1")
    .get(zoneId, zone) as { content: string } | undefined
  const n = r ? Number(r.content.trim().split(/\s+/)[2]) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Raises a zone's SOA serial by one step, once per merge that changed its records. */
export function bumpLocalSerial(db: Database.Database, zone: string, now = new Date()): void {
  const row = db
    .prepare("SELECT r.id, r.content FROM records r JOIN rrsets s ON s.id = r.rrset_id JOIN zones z ON z.id = s.zone_id WHERE z.name = ? AND s.name = z.name AND s.type = 'SOA' LIMIT 1")
    .get(zone) as { id: number; content: string } | undefined
  if (!row) return
  const next = nextSerial(Number(row.content.trim().split(/\s+/)[2]) || 0, now)
  db.prepare('UPDATE records SET content = ? WHERE id = ?').run(withSoaSerial(row.content, next), row.id)
}

function linksComplete(db: Database.Database, userId: number, wanted: string[]): boolean {
  const have = (db.prepare('SELECT a.name FROM user_accounts ua JOIN accounts a ON a.id = ua.account_id WHERE ua.user_id = ?').all(userId) as { name: string }[]).map((r) => r.name)
  return wanted.every((n) => have.includes(n))
}

