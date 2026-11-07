import type { KeyObject } from 'node:crypto'
import type { Rdata } from '../dns/rdata.js'
import { dnskeyRdata, privateKeyObject, type DnssecKey } from './keys.js'
import { signRRset, type SignableSet } from './sign.js'

export interface SignerOptions {
  now?: () => number
  /** How long signatures stay valid, seconds. Default 7 days. */
  validitySeconds?: number
  /** Signatures older than this are renewed on next use. Default 1 day. */
  renewAfterSeconds?: number
}

/**
 * Signs a zone's RRsets on demand, the first time a validating resolver asks, and remembers the result until the zone
 * is rebuilt (every change builds a new Zone, so stale signatures cannot outlive the data they cover).
 */
export class ZoneSigner {
  private readonly cache = new WeakMap<object, { at: number; sigs: Buffer[] }>()
  private readonly signing: { key: DnssecKey; privateKey: KeyObject }[]
  private readonly now: () => number
  private readonly validity: number
  private readonly renew: number

  constructor(
    readonly apex: string,
    readonly keys: DnssecKey[],
    opts: SignerOptions = {},
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.validity = opts.validitySeconds ?? 7 * 86400
    this.renew = opts.renewAfterSeconds ?? 86400
    this.signing = keys.filter((k) => k.active).map((key) => ({ key, privateKey: privateKeyObject(key.privateKeyPem) }))
    if (this.signing.length === 0) throw new Error('a signed zone needs at least one active key')
  }

  /** DNSKEY rdata for every published key. */
  dnskeys(): Rdata[] {
    return this.keys.filter((k) => k.published).map((k) => ({ wire: dnskeyRdata(k.flags, k.algorithm, k.publicKey) }))
  }

  /** One RRSIG rdata per active key. */
  signatures(set: SignableSet): Buffer[] {
    const t = this.now()
    const hit = this.cache.get(set)
    if (hit && t - hit.at < this.renew) return hit.sigs
    const window = { inception: t - 3600, expiration: t + this.validity }
    const sigs = this.signing.map(({ key, privateKey }) => signRRset({ algorithm: key.algorithm, keyTag: key.keyTag, privateKey }, this.apex, set, window))
    this.cache.set(set, { at: t, sigs })
    return sigs
  }
}
