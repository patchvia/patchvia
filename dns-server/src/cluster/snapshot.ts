import type Database from 'better-sqlite3'
import { canonical, hashOf, key, normalizeSoa, type EntityKind } from './entities.js'

export interface SnapshotEntry {
  key: string
  kind: EntityKind
  json: string
  hash: string
}

export interface SnapshotScope {
  /** Accounts, users, API keys, zones, dynamic DNS tokens and DNSSEC keys: everything except the records themselves */
  small: boolean
  /** Zones whose records to include (the bulk of the data). 'all' for every zone. */
  zones: ReadonlySet<string> | 'all'
}

const entry = (k: string, kind: EntityKind, payload: unknown): SnapshotEntry => {
  const json = canonical(payload)
  return { key: k, kind, json, hash: hashOf(json) }
}

/**
 * The cluster's view of this node's live data: each replicated thing as a keyed, canonical JSON entity. Capture diffs this
 * against what was last replicated; reconcile compares it with what the merge says it should be.
 * Secondary zones are replicated as a zone (so every node learns of it) but their records are not: each node transfers
 * them from the primary itself.
 */
export function buildSnapshot(db: Database.Database, scope: SnapshotScope): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>()
  const add = (e: SnapshotEntry) => out.set(e.key, e)

  const zones = db.prepare('SELECT z.id, z.name, z.kind, z.masters, a.name AS account FROM zones z LEFT JOIN accounts a ON a.id = z.account_id').all() as {
    id: number
    name: string
    kind: string
    masters: string | null
    account: string | null
  }[]

  if (scope.small) {
    for (const a of db.prepare('SELECT name, description FROM accounts').all() as { name: string; description: string }[]) {
      add(entry(key.account(a.name), 'account', { description: a.description }))
    }
    const links = new Map<number, string[]>()
    for (const l of db.prepare('SELECT ua.user_id AS uid, a.name FROM user_accounts ua JOIN accounts a ON a.id = ua.account_id').all() as { uid: number; name: string }[]) {
      links.set(l.uid, [...(links.get(l.uid) ?? []), l.name])
    }
    const usernames = new Map<number, string>()
    for (const u of db.prepare('SELECT id, username, password_hash AS passwordHash, role, token_version AS tokenVersion FROM users').all() as {
      id: number
      username: string
      passwordHash: string
      role: string
      tokenVersion: number
    }[]) {
      usernames.set(u.id, u.username)
      add(entry(key.user(u.username), 'user', { passwordHash: u.passwordHash, role: u.role, tokenVersion: u.tokenVersion, accounts: (links.get(u.id) ?? []).sort() }))
    }
    for (const k of db.prepare('SELECT user_id AS uid, name, prefix, hash, scope FROM api_keys').all() as { uid: number; name: string; prefix: string; hash: string; scope: string }[]) {
      const user = usernames.get(k.uid)
      if (user) add(entry(key.apikey(k.hash), 'apikey', { user, name: k.name, prefix: k.prefix, scope: k.scope }))
    }
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    for (const z of zones) {
      add(entry(key.zone(z.name), 'zone', { kind: z.kind, masters: z.masters ? (JSON.parse(z.masters) as string[]) : [], account: z.account }))
    }
    for (const t of db.prepare('SELECT zone_id AS zid, name, ttl, prefix, token_hash AS hash FROM dyndns_tokens').all() as { zid: number; name: string; ttl: number; prefix: string; hash: string }[]) {
      const z = zoneById.get(t.zid)
      if (z && z.kind !== 'slave') add(entry(key.ddns(z.name, t.name), 'ddns', { ttl: t.ttl, prefix: t.prefix, hash: t.hash }))
    }
    for (const k of db
      .prepare('SELECT zone_id AS zid, algorithm, flags, private_key AS privateKeyPem, public_key AS publicKey, key_tag AS keyTag, active, published FROM dnssec_keys')
      .all() as { zid: number; algorithm: number; flags: number; privateKeyPem: string; publicKey: string; keyTag: number; active: number; published: number }[]) {
      const z = zoneById.get(k.zid)
      if (z && z.kind !== 'slave') {
        add(entry(key.dnssec(z.name, k.keyTag), 'dnssec', { algorithm: k.algorithm, flags: k.flags, privateKeyPem: k.privateKeyPem, publicKey: k.publicKey, keyTag: k.keyTag, active: k.active === 1, published: k.published === 1 }))
      }
    }
  }

  const wanted = scope.zones === 'all' ? zones : zones.filter((z) => scope.zones !== 'all' && scope.zones.has(z.name))
  const sets = db.prepare('SELECT id, name, type, ttl FROM rrsets WHERE zone_id = ?')
  const recs = db.prepare('SELECT content, disabled FROM records WHERE rrset_id = ?')
  for (const z of wanted) {
    if (z.kind === 'slave') continue
    for (const s of sets.all(z.id) as { id: number; name: string; type: string; ttl: number }[]) {
      const records = (recs.all(s.id) as { content: string; disabled: number }[])
        .map((r) => ({ c: s.type === 'SOA' ? normalizeSoa(r.content) : r.content, d: r.disabled === 1 }))
        .sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0))
      add(entry(key.rrset(z.name, s.name, s.type), 'rrset', { ttl: s.ttl, records }))
    }
  }
  return out
}
