import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { ResetError, resetPassword } from '../src/cli/reset-password.js'
import { openDatabase } from '../src/db/database.js'
import { UsersRepository } from '../src/users/users.repository.js'
import { Net } from './cluster-harness.js'

async function setup() {
  const db = openDatabase(':memory:')
  const repo = new UsersRepository(db)
  repo.create('admin', await hashPassword('old-password-123'), 'admin')
  repo.create('dana', await hashPassword('dana-password-123'), 'user')
  return { db, repo }
}

describe('reset-password', () => {
  it('sets the new password, ends the old sessions, and leaves other users alone', async () => {
    const { db, repo } = await setup()
    const before = repo.getByUsername('admin')!
    const out = await resetPassword(db, 'admin', 'brand-new-password-1')
    expect(out).toEqual({ username: 'admin', role: 'admin' })
    const after = repo.getByUsername('admin')!
    expect(await verifyPassword('brand-new-password-1', after.passwordHash)).toBe(true)
    expect(await verifyPassword('old-password-123', after.passwordHash)).toBe(false)
    expect(after.tokenVersion).toBe(before.tokenVersion + 1) // every existing login token stops working
    const dana = repo.getByUsername('dana')!
    expect(await verifyPassword('dana-password-123', dana.passwordHash)).toBe(true)
    expect(dana.tokenVersion).toBe(0)
  })

  it('finds the user whatever the case or spacing, and keeps role and accounts', async () => {
    const { db, repo } = await setup()
    await resetPassword(db, '  ADMIN ', 'brand-new-password-1')
    expect(repo.getByUsername('admin')!.role).toBe('admin')
  })

  it('refuses an unknown user and names the real ones', async () => {
    const { db } = await setup()
    await expect(resetPassword(db, 'ghost', 'brand-new-password-1')).rejects.toThrow(/no user named "ghost".*admin, dana/)
    await expect(resetPassword(db, 'ghost', 'x')).rejects.toBeInstanceOf(ResetError)
  })

  it('refuses a password that is too short and changes nothing', async () => {
    const { db, repo } = await setup()
    const before = repo.getByUsername('admin')!
    await expect(resetPassword(db, 'admin', 'short')).rejects.toThrow(/at least 10/)
    const after = repo.getByUsername('admin')!
    expect(after.passwordHash).toBe(before.passwordHash)
    expect(after.tokenVersion).toBe(before.tokenVersion)
  })

  it('says what to do when the server has no users at all', async () => {
    const db = openDatabase(':memory:')
    await expect(resetPassword(db, 'admin', 'brand-new-password-1')).rejects.toThrow(/ADMIN_PASSWORD/)
  })

  it('reaches the other nodes of a cluster, and signs the user out there too', async () => {
    const net = new Net()
    const a = net.node('ns1', ['ns2'])
    const b = net.node('ns2', ['ns1'])
    await a.addUser('admin', 'admin')
    await net.sync()
    const synced = b.users.getByUsername('admin')!
    expect(await verifyPassword('password-for-admin', synced.passwordHash)).toBe(true)

    // run on ns1's database alone, as the command does: no HTTP request, no cluster call
    await resetPassword(a.db, 'admin', 'recovered-password-9')
    await net.sync()

    const after = b.users.getByUsername('admin')!
    expect(await verifyPassword('recovered-password-9', after.passwordHash)).toBe(true)
    expect(after.tokenVersion).toBe(synced.tokenVersion + 1)
  })
})
