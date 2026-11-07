import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { labelsOf, nameToWire } from '../dns/names.js'
import { RType } from '../dns/types.js'
import { dnskeyRdata, keyTag, publicKeyObject, type DnssecKey } from './keys.js'

export interface SignableSet {
  name: string
  type: number
  ttl: number
  rdatas: { wire: Buffer }[]
}

export interface SigningWindow {
  /** Seconds since epoch */
  inception: number
  expiration: number
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

/** Labels field of an RRSIG: the owner's label count, not counting a leading wildcard (RFC 4034 3.1.3). */
export function rrsigLabels(owner: string): number {
  const ls = labelsOf(owner)
  return ls[0] === '*' ? ls.length - 1 : ls.length
}

/** RRSIG rdata up to, and including, the signer name: the part that is signed along with the data. */
function rrsigHeader(type: number, algorithm: number, labels: number, ttl: number, win: SigningWindow, tag: number, signer: string): Buffer {
  return Buffer.concat([u16(type), Buffer.from([algorithm, labels]), u32(ttl), u32(win.expiration), u32(win.inception), u16(tag), nameToWire(signer)])
}

/** The RRset in canonical form (RFC 4034 6.3): each RR in full with the original TTL, sorted by rdata, duplicates removed. */
function canonicalRRset(set: SignableSet): Buffer {
  const owner = nameToWire(set.name)
  const sorted = [...set.rdatas].sort((a, b) => Buffer.compare(a.wire, b.wire))
  const parts: Buffer[] = []
  let prev: Buffer | undefined
  for (const r of sorted) {
    if (prev && prev.equals(r.wire)) continue
    prev = r.wire
    parts.push(owner, u16(set.type), u16(1), u32(set.ttl), u16(r.wire.length), r.wire)
  }
  return Buffer.concat(parts)
}

/** An RRSIG rdata for `set`, signed by `key` (RFC 4034 3). `signer` is the zone apex. */
export function signRRset(key: Pick<DnssecKey, 'algorithm' | 'keyTag'> & { privateKey: KeyObject }, signer: string, set: SignableSet, win: SigningWindow): Buffer {
  const header = rrsigHeader(set.type, key.algorithm, rrsigLabels(set.name), set.ttl, win, key.keyTag, signer)
  // P-256 signatures in DNSSEC are the raw r||s pair (RFC 6605 4), which is Node's "ieee-p1363" encoding
  const sig = cryptoSign('sha256', Buffer.concat([header, canonicalRRset(set)]), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return Buffer.concat([header, sig])
}

export interface ParsedRrsig {
  covered: number
  algorithm: number
  labels: number
  originalTtl: number
  expiration: number
  inception: number
  keyTag: number
  signer: string
  signature: Buffer
  header: Buffer
}

export function parseRrsig(rdata: Buffer): ParsedRrsig {
  let p = 18
  const labels: string[] = []
  while (rdata[p] !== 0) {
    labels.push(rdata.toString('latin1', p + 1, p + 1 + rdata[p]!))
    p += rdata[p]! + 1
  }
  p++
  return {
    covered: rdata.readUInt16BE(0),
    algorithm: rdata[2]!,
    labels: rdata[3]!,
    originalTtl: rdata.readUInt32BE(4),
    expiration: rdata.readUInt32BE(8),
    inception: rdata.readUInt32BE(12),
    keyTag: rdata.readUInt16BE(16),
    signer: labels.join('.'),
    signature: rdata.subarray(p),
    header: rdata.subarray(0, p),
  }
}

/**
 * Verifies an RRSIG the way a validator would, from the DNSKEY alone: rebuilds the signed data from the RRset, using
 * the RRSIG's labels field to undo wildcard expansion (RFC 4035 5.3.2). Returns a reason when it fails.
 */
export function verifyRRset(dnskey: { flags: number; algorithm: number; publicKey: Buffer }, rrsigRdata: Buffer, set: SignableSet, nowSeconds: number): string | null {
  const sig = parseRrsig(rrsigRdata)
  if (sig.covered !== set.type) return 'RRSIG covers a different type'
  if (sig.keyTag !== keyTag(dnskeyRdata(dnskey.flags, dnskey.algorithm, dnskey.publicKey))) return 'key tag does not match'
  if (nowSeconds < sig.inception) return 'signature is not yet valid'
  if (nowSeconds > sig.expiration) return 'signature has expired'
  const ls = labelsOf(set.name)
  if (sig.labels > ls.length) return 'labels field exceeds the owner name'
  // Wildcard expansion: the signature was made over *.<rightmost labels>, not the name we were given
  const owner = sig.labels < ls.length ? ['*', ...ls.slice(ls.length - sig.labels)].join('.') : set.name
  const data = Buffer.concat([sig.header, canonicalRRset({ ...set, name: owner, ttl: sig.originalTtl })])
  const ok = cryptoVerify('sha256', data, { key: publicKeyObject(dnskey.publicKey), dsaEncoding: 'ieee-p1363' }, sig.signature)
  return ok ? null : 'signature does not verify'
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest()
export { RType }
