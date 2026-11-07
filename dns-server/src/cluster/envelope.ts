import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Every message between nodes is sealed with AES-256-GCM under a key derived from the cluster secret. That makes it
 * confidential (DNSSEC private keys travel in it), authenticated (only holders of the secret can produce one) and
 * bound to its purpose, even over plain HTTP. A timestamp limits how long a captured message stays acceptable.
 */
const SALT = Buffer.from('dns-cluster-v1')

export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, Buffer.from(purpose, 'utf8'), 32))
}

export class EnvelopeError extends Error {}

export function seal(secret: string, context: string, payload: object, now = Date.now()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, 'envelope'), iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const body = Buffer.concat([cipher.update(JSON.stringify({ ts: now, p: payload }), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** Throws EnvelopeError with a deliberately vague message: never tell a stranger which check failed. */
export function open<T = unknown>(secret: string, context: string, token: string, now = Date.now(), maxSkewMs = 5 * 60_000): T {
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 12 + 16 + 2) throw new Error('short')
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, 'envelope'), raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(raw.subarray(12, 28))
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    const { ts, p } = JSON.parse(json) as { ts: number; p: T }
    if (typeof ts !== 'number' || Math.abs(now - ts) > maxSkewMs) throw new Error('stale')
    return p
  } catch {
    throw new EnvelopeError('invalid cluster message')
  }
}
