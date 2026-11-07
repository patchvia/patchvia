import type Database from 'better-sqlite3'

export type Role = 'admin' | 'operator' | 'user'
export const ROLES: readonly Role[] = ['admin', 'operator', 'user']

export interface User {
  id: number
  username: string
  role: Role
  tokenVersion: number
  createdAt: string
  accountIds: number[]
}

export interface Account {
  id: number
  name: string
  description: string
  createdAt: string
}

export type ApiKeyScope = 'read' | 'write'

export interface ApiKeyRow {
  id: number
  userId: number
  name: string
  prefix: string
  scope: ApiKeyScope
  createdAt: string
  lastUsedAt: string | null
}

const USER_COLS = 'id, username, role, token_version AS tokenVersion, created_at AS createdAt'
const KEY_COLS = 'id, user_id AS userId, name, prefix, scope, created_at AS createdAt, last_used_at AS lastUsedAt'

export class UsersRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  }

  countByRole(role: Role): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role) as { n: number }).n
  }

  create(username: string, passwordHash: string, role: Role): User {
    const info = this.db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role)
    return this.get(Number(info.lastInsertRowid))!
  }

  get(id: number): User | undefined {
    const row = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as Omit<User, 'accountIds'> | undefined
    return row && { ...row, accountIds: this.accountIds(id) }
  }

  getByUsername(username: string): (User & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare(`SELECT ${USER_COLS}, password_hash AS passwordHash FROM users WHERE username = ?`)
      .get(username) as (Omit<User, 'accountIds'> & { passwordHash: string }) | undefined
    return row && { ...row, accountIds: this.accountIds(row.id) }
  }

  getPasswordHash(id: number): string | undefined {
    return (this.db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(id) as { h: string } | undefined)?.h
  }

  list(): User[] {
    const rows = this.db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY username`).all() as Omit<User, 'accountIds'>[]
    return rows.map((r) => ({ ...r, accountIds: this.accountIds(r.id) }))
  }

  /** Bumping the token version invalidates every session of that user. */
  update(id: number, patch: { role?: Role; passwordHash?: string }): void {
    if (patch.role) this.db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(patch.role, id)
    if (patch.passwordHash) this.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(patch.passwordHash, id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }

  accountIds(userId: number): number[] {
    return (this.db.prepare('SELECT account_id AS id FROM user_accounts WHERE user_id = ? ORDER BY account_id').all(userId) as { id: number }[]).map((r) => r.id)
  }

  setAccounts(userId: number, accountIds: number[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM user_accounts WHERE user_id = ?').run(userId)
      const ins = this.db.prepare('INSERT INTO user_accounts (user_id, account_id) VALUES (?, ?)')
      for (const id of new Set(accountIds)) ins.run(userId, id)
    })
  }

  // accounts
  listAccounts(): Account[] {
    return this.db.prepare('SELECT id, name, description, created_at AS createdAt FROM accounts ORDER BY name').all() as Account[]
  }

  getAccount(id: number): Account | undefined {
    return this.db.prepare('SELECT id, name, description, created_at AS createdAt FROM accounts WHERE id = ?').get(id) as Account | undefined
  }

  createAccount(name: string, description: string): Account {
    const info = this.db.prepare('INSERT INTO accounts (name, description) VALUES (?, ?)').run(name, description)
    return this.getAccount(Number(info.lastInsertRowid))!
  }

  updateAccount(id: number, patch: { name?: string; description?: string }): void {
    if (patch.name !== undefined) this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(patch.name, id)
    if (patch.description !== undefined) this.db.prepare('UPDATE accounts SET description = ? WHERE id = ?').run(patch.description, id)
  }

  deleteAccount(id: number): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  // api keys
  createKey(k: { userId: number; name: string; prefix: string; hash: string; scope: ApiKeyScope }): ApiKeyRow {
    const info = this.db.prepare('INSERT INTO api_keys (user_id, name, prefix, hash, scope) VALUES (?, ?, ?, ?, ?)').run(k.userId, k.name, k.prefix, k.hash, k.scope)
    return this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`).get(Number(info.lastInsertRowid)) as ApiKeyRow
  }

  listKeys(userId?: number): ApiKeyRow[] {
    return (
      userId === undefined
        ? this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys ORDER BY id`).all()
        : this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE user_id = ? ORDER BY id`).all(userId)
    ) as ApiKeyRow[]
  }

  getKey(id: number): ApiKeyRow | undefined {
    return this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`).get(id) as ApiKeyRow | undefined
  }

  getKeyByHash(hash: string): ApiKeyRow | undefined {
    return this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE hash = ?`).get(hash) as ApiKeyRow | undefined
  }

  touchKey(id: number): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id)
  }

  deleteKey(id: number): void {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }
}
