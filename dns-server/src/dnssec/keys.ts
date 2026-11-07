import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { nameToWire } from '../dns/names.js'

/** ECDSA Curve P-256 with SHA-256 (RFC 6605): small keys and signatures, universally validated. */
export const ALG_ECDSAP256SHA256 = 13
export const ALGORITHM_NAMES: Record<number, string> = { 13: 'ECDSAP256SHA256' }

export const FLAG_ZONE = 256
export const FLAG_SEP = 1

export interface DnssecKey {
  id?: number
  flags: number
  algorithm: number
  /** PKCS#8 PEM */
  privateKeyPem: string
  /** Raw public key: X || Y, 64 bytes for P-256 */
  publicKey: Buffer
  keyTag: number
  /** Signs RRsets */
  active: boolean
  /** Appears in the zone's DNSKEY RRset (a key must be published before it signs, and stay until old signatures expire) */
  published: boolean
}

/** A fresh key. Flags 257 (zone key + secure entry point) makes it a combined signing key, the usual choice for ECDSA. */
export function generateKey(flags = FLAG_ZONE | FLAG_SEP): Pick<DnssecKey, 'flags' | 'algorithm' | 'privateKeyPem' | 'publicKey' | 'keyTag'> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { flags, algorithm: ALG_ECDSAP256SHA256, privateKeyPem: pem, publicKey: raw, keyTag: keyTag(dnskeyRdata(flags, ALG_ECDSAP256SHA256, raw)) }
}

/** DNSKEY rdata: flags, protocol (always 3), algorithm, public key (RFC 4034 2.1). */
export function dnskeyRdata(flags: number, algorithm: number, publicKey: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(flags, 0)
  head[2] = 3
  head[3] = algorithm
  return Buffer.concat([head, publicKey])
}

/** Key tag (RFC 4034 Appendix B): a checksum that lets a validator pick the right key quickly, not a security property. */
export function keyTag(rdata: Buffer): number {
  let ac = 0
  for (let i = 0; i < rdata.length; i++) ac += i & 1 ? rdata[i]! : rdata[i]! << 8
  ac += (ac >> 16) & 0xffff
  return ac & 0xffff
}

export interface DsRecord {
  keyTag: number
  algorithm: number
  digestType: 2 | 4
  /** Upper-case hex */
  digest: string
}

/** DS records for the parent zone: digest of (owner name in wire form || DNSKEY rdata), SHA-256 and SHA-384 (RFC 4509, RFC 6605). */
export function dsRecords(owner: string, key: Pick<DnssecKey, 'flags' | 'algorithm' | 'publicKey'>): DsRecord[] {
  const rdata = dnskeyRdata(key.flags, key.algorithm, key.publicKey)
  const tag = keyTag(rdata)
  const input = Buffer.concat([nameToWire(owner), rdata])
  return ([
    [2, 'sha256'],
    [4, 'sha384'],
  ] as const).map(([digestType, algo]) => ({
    keyTag: tag,
    algorithm: key.algorithm,
    digestType,
    digest: createHash(algo).update(input).digest('hex').toUpperCase(),
  }))
}

/** Presentation form of a DNSKEY record's rdata, as registrars and `dig` show it. */
export function dnskeyPresentation(key: Pick<DnssecKey, 'flags' | 'algorithm' | 'publicKey'>): string {
  return `${key.flags} 3 ${key.algorithm} ${key.publicKey.toString('base64')}`
}

export function privateKeyObject(pem: string): KeyObject {
  return createPrivateKey(pem)
}

/** A P-256 public key as a Node KeyObject from the raw X||Y form. Used to verify signatures in tests and health checks. */
export function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32).toString('base64url') }, format: 'jwk' })
}
