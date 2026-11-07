import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'node:crypto'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../common/errors.js'
import { CONFIG, type Config } from '../config/config.js'
import { deriveKey } from '../cluster/envelope.js'
import { SettingsRepository } from '../db/settings.js'
import { ValidationError } from '../dns/names.js'
import { UsersRepository, type ApiKeyScope, type User } from '../users/users.repository.js'
import { assertValidPassword, hashPassword, verifyPassword } from './password.js'
import type { Principal } from './principal.js'

const FAILURE_WINDOW_MS = 60_000
const MAX_FAILURES = 5
const KEY_PREFIX = 'dnk_'
/** A hash to compare against when the user does not exist, so timing does not reveal valid usernames. */
const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86)

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('Auth')
  private readonly failures = new Map<string, number[]>()
  private secret = ''

  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  async onModuleInit() {
    // In a cluster every node must accept the others' login tokens, so the signing secret is derived from the shared one
    this.secret =
      this.cfg.jwtSecret ??
      (this.cfg.clusterSecret ? deriveKey(this.cfg.clusterSecret, 'jwt').toString('base64url') : (this.settings.get('jwtSecret') ?? this.generateSecret()))
    if (this.users.count() > 0) return
    if (this.cfg.clusterSecret && !this.cfg.adminPassword) {
      // A random password invented here would clash with the other nodes' users once they sync
      this.log.warn('Cluster mode: no users yet. Set ADMIN_PASSWORD (the same on every node) to create "admin", or wait for the first sync to bring users in.')
      return
    }
    const generated = !this.cfg.adminPassword
    const password = this.cfg.adminPassword ?? randomBytes(12).toString('base64url')
    assertValidPassword(password)
    const hash = await hashPassword(password)
    // Hashing takes a while; in a cluster the first sync may have brought users in meanwhile. Nothing awaits between this
    // check and the insert, so it cannot race again.
    if (this.users.count() > 0) {
      this.log.log('Users arrived from the cluster while starting; not creating "admin".')
      return
    }
    this.users.create('admin', hash, 'admin')
    if (generated) this.log.warn(`No ADMIN_PASSWORD was set. The "admin" password is: ${password}  (shown once, change it after signing in)`)
    else this.log.log('Created user "admin" from ADMIN_PASSWORD.')
  }

  private generateSecret(): string {
    const s = randomBytes(48).toString('base64url')
    this.settings.set('jwtSecret', s)
    return s
  }

  private sign(user: User): string {
    // `u` is the stable identity: numeric ids differ between cluster nodes, so a token must never be resolved by id alone
    return jwt.sign({ tv: user.tokenVersion, u: user.username }, this.secret, {
      subject: String(user.id),
      expiresIn: `${this.cfg.sessionHours}h` as jwt.SignOptions['expiresIn'],
      algorithm: 'HS256',
    })
  }

  async login(username: string, password: string, ip: string, now = Date.now()): Promise<{ token: string; expiresInHours: number; user: User }> {
    const bucket = `${ip}|${username.toLowerCase()}`
    const recent = (this.failures.get(bucket) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS)
    if (recent.length >= MAX_FAILURES) throw new TooManyRequestsError('Too many failed attempts, try again in a minute')
    const found = this.users.getByUsername(username.toLowerCase())
    const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH)
    if (!found || !ok) {
      this.failures.set(bucket, [...recent, now])
      throw new UnauthorizedError('Invalid username or password')
    }
    this.failures.delete(bucket)
    const { passwordHash: _omit, ...user } = found
    return { token: this.sign(user), expiresInHours: this.cfg.sessionHours, user }
  }

  /** Resolves `Authorization: Bearer <jwt|api key>` or `X-API-Key` into a principal. */
  authenticate(headers: Record<string, string | string[] | undefined>): Principal {
    const auth = headers.authorization
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
    const apiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined
    const credential = apiKey ?? bearer
    if (!credential) throw new UnauthorizedError('Authentication required')
    return credential.startsWith(KEY_PREFIX) ? this.fromKey(credential) : this.fromToken(credential)
  }

  private fromToken(token: string): Principal {
    let claims: jwt.JwtPayload
    try {
      claims = jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload
    } catch {
      throw new UnauthorizedError('Invalid or expired token')
    }
    const user = typeof claims.u === 'string' ? this.users.getByUsername(claims.u) : this.users.get(Number(claims.sub))
    if (!user || user.tokenVersion !== claims.tv) throw new UnauthorizedError('Session is no longer valid')
    return { id: user.id, username: user.username, role: user.role, accountIds: user.accountIds, via: 'session', scope: 'full' }
  }

  private fromKey(key: string): Principal {
    const row = this.users.getKeyByHash(hashKey(key))
    const user = row && this.users.get(row.userId)
    if (!row || !user) throw new UnauthorizedError('Invalid API key')
    this.users.touchKey(row.id)
    return { id: user.id, username: user.username, role: user.role, accountIds: user.accountIds, via: 'key', scope: row.scope }
  }

  async changePassword(userId: number, current: string, next: string): Promise<{ token: string }> {
    assertValidPassword(next)
    const stored = this.users.getPasswordHash(userId)
    if (!stored || !(await verifyPassword(current, stored))) throw new ForbiddenError('Current password is incorrect')
    if (current === next) throw new ValidationError('new password must differ from the current one')
    this.users.update(userId, { passwordHash: await hashPassword(next) })
    return { token: this.sign(this.users.get(userId)!) }
  }

  createKey(userId: number, name: string, scope: ApiKeyScope) {
    const key = KEY_PREFIX + randomBytes(24).toString('base64url')
    const row = this.users.createKey({ userId, name, prefix: key.slice(0, 10), hash: hashKey(key), scope })
    return { ...row, key } // the only time the secret is ever visible
  }
}
