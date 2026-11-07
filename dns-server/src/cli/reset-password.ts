import type Database from 'better-sqlite3'
import { assertValidPassword, hashPassword } from '../auth/password.js'
import { UsersRepository, type Role } from '../users/users.repository.js'

export class ResetError extends Error {}

/**
 * Sets a new password for an existing user straight in the database, for when nobody can sign in to do it through the
 * console. Every session of that user ends (the token version is bumped by the repository). In a cluster the change reaches
 * the other nodes on their next sync, like any other change made on this node.
 */
export async function resetPassword(db: Database.Database, username: string, password: string): Promise<{ username: string; role: Role }> {
  const repo = new UsersRepository(db)
  const name = username.trim().toLowerCase()
  const user = repo.getByUsername(name)
  if (!user) {
    const known = repo.list().map((u) => u.username)
    throw new ResetError(`no user named "${name}".` + (known.length ? ` Users on this server: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}` : ' This server has no users yet: set ADMIN_PASSWORD and restart to create "admin".'))
  }
  try {
    assertValidPassword(password)
  } catch (e) {
    throw new ResetError((e as Error).message)
  }
  repo.update(user.id, { passwordHash: await hashPassword(password) })
  return { username: user.username, role: user.role }
}
