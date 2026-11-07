import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS: string[] = [
  `CREATE TABLE zones (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL DEFAULT 'native',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE rrsets (
     id INTEGER PRIMARY KEY,
     zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     ttl INTEGER NOT NULL,
     UNIQUE (zone_id, name, type)
   );
   CREATE TABLE records (
     id INTEGER PRIMARY KEY,
     rrset_id INTEGER NOT NULL REFERENCES rrsets(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX records_rrset ON records(rrset_id);`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   ALTER TABLE zones ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
   CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'user')),
     token_version INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE user_accounts (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     PRIMARY KEY (user_id, account_id)
   );
   CREATE TABLE api_keys (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     prefix TEXT NOT NULL,
     hash TEXT NOT NULL UNIQUE,
     scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_used_at TEXT
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     actor TEXT NOT NULL,
     zone TEXT,
     action TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX audit_zone ON audit(zone, id DESC);`,
  `ALTER TABLE zones ADD COLUMN masters TEXT;
   ALTER TABLE zones ADD COLUMN last_check TEXT;
   ALTER TABLE zones ADD COLUMN last_transfer TEXT;
   ALTER TABLE zones ADD COLUMN transfer_error TEXT;`,
  `CREATE TABLE dnssec_keys (
     id INTEGER PRIMARY KEY,
     zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
     algorithm INTEGER NOT NULL,
     flags INTEGER NOT NULL,
     private_key TEXT NOT NULL,
     public_key TEXT NOT NULL,
     key_tag INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     published INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX dnssec_keys_zone ON dnssec_keys(zone_id);`,
  `CREATE TABLE dyndns_tokens (
     id INTEGER PRIMARY KEY,
     zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     ttl INTEGER NOT NULL DEFAULT 60,
     prefix TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     last_ip4 TEXT,
     last_ip6 TEXT,
     last_used_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     UNIQUE (zone_id, name)
   );`,
  `CREATE TABLE cluster_entities (
     key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     hlc TEXT NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL,
     hash TEXT NOT NULL,
     seq INTEGER NOT NULL,
     live INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX cluster_entities_seq ON cluster_entities(seq);
   CREATE INDEX cluster_entities_kind ON cluster_entities(kind);
   CREATE TABLE cluster_peers (
     address TEXT PRIMARY KEY,
     node_id TEXT,
     last_seq INTEGER NOT NULL DEFAULT 0,
     last_contact TEXT,
     last_error TEXT
   );`,
]

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}
