import { Inject, Injectable } from '@nestjs/common'
import { assertValidPassword, hashPassword } from '../auth/password.js'
import { ForbiddenError } from '../common/errors.js'
import { ValidationError } from '../dns/names.js'
import { ConflictError, NotFoundError } from '../zones/zone-service.js'
import { UsersRepository, type Account, type Role, type User } from './users.repository.js'

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/

@Injectable()
export class UsersService {
  constructor(@Inject(UsersRepository) private readonly repo: UsersRepository) {}

  list(): User[] {
    return this.repo.list()
  }

  get(id: number): User {
    const u = this.repo.get(id)
    if (!u) throw new NotFoundError(`user ${id} not found`)
    return u
  }

  async create(input: { username: string; password: string; role: Role; accountIds?: number[] }): Promise<User> {
    const username = input.username.trim().toLowerCase()
    if (!USERNAME.test(username)) throw new ValidationError('username must be 3-64 characters: a-z, 0-9, dot, dash, underscore')
    assertValidPassword(input.password)
    this.assertAccounts(input.accountIds ?? [])
    if (this.repo.getByUsername(username)) throw new ConflictError(`user ${username} already exists`)
    const hash = await hashPassword(input.password)
    return this.repo.transaction(() => {
      const user = this.repo.create(username, hash, input.role)
      if (input.accountIds?.length) this.repo.setAccounts(user.id, input.accountIds)
      return this.get(user.id)
    })
  }

  async update(actorId: number, id: number, patch: { role?: Role; password?: string; accountIds?: number[] }): Promise<User> {
    const user = this.get(id)
    if (patch.role && patch.role !== user.role && user.role === 'admin' && this.repo.countByRole('admin') <= 1) {
      throw new ForbiddenError('cannot demote the last administrator')
    }
    if (patch.role && id === actorId && patch.role !== user.role) throw new ForbiddenError('you cannot change your own role')
    if (patch.accountIds) this.assertAccounts(patch.accountIds)
    let passwordHash: string | undefined
    if (patch.password !== undefined) {
      assertValidPassword(patch.password)
      passwordHash = await hashPassword(patch.password)
    }
    this.repo.transaction(() => {
      this.repo.update(id, { role: patch.role !== user.role ? patch.role : undefined, passwordHash })
      if (patch.accountIds) this.repo.setAccounts(id, patch.accountIds)
    })
    return this.get(id)
  }

  delete(actorId: number, id: number): void {
    const user = this.get(id)
    if (id === actorId) throw new ForbiddenError('you cannot delete yourself')
    if (user.role === 'admin' && this.repo.countByRole('admin') <= 1) throw new ForbiddenError('cannot delete the last administrator')
    this.repo.delete(id)
  }

  // accounts
  listAccounts(): Account[] {
    return this.repo.listAccounts()
  }

  createAccount(name: string, description = ''): Account {
    return this.repo.createAccount(name.trim(), description)
  }

  updateAccount(id: number, patch: { name?: string; description?: string }): Account {
    this.requireAccount(id)
    this.repo.updateAccount(id, patch)
    return this.requireAccount(id)
  }

  deleteAccount(id: number): void {
    this.requireAccount(id)
    this.repo.deleteAccount(id)
  }

  requireAccount(id: number): Account {
    const a = this.repo.getAccount(id)
    if (!a) throw new NotFoundError(`account ${id} not found`)
    return a
  }

  private assertAccounts(ids: number[]) {
    for (const id of ids) if (!this.repo.getAccount(id)) throw new ValidationError(`account ${id} does not exist`)
  }
}
