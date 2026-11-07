import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { ValidationError } from '../dns/names.js'

const N = 16384
const KEYLEN = 64
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 256

function derive(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

export function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  if (password.length > MAX_PASSWORD_LENGTH) throw new ValidationError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`)
}

/** Format: scrypt$N$salt$hash (base64url). The cost is stored so it can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N)
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !n || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
