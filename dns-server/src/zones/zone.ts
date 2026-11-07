import { isAtOrBelow, labelsOf, normalizeName, parentOf, validateName, ValidationError } from '../dns/names.js'
import { encodeRdata, soaMinimum, soaSerial, soaToContent, type Rdata } from '../dns/rdata.js'
import { buildNsecChain, type NsecChain } from '../dnssec/nsec.js'
import type { ZoneSigner } from '../dnssec/signer.js'
import { RType, typeName, typeNumber, type RTypeName } from '../dns/types.js'

export interface RRset {
  name: string
  type: number
  ttl: number
  rdatas: Rdata[]
}

export interface RRsetInput {
  name: string
  type: RTypeName
  ttl: number
  contents: string[]
}

export interface Delegation {
  name: string
  ns: RRset
}

/** Immutable, query-optimised view of one zone. Built from stored records, rebuilt on every write. */
export class Zone {
  private readonly byName = new Map<string, Map<number, RRset>>()
  private readonly ancestors = new Set<string>()
  readonly soa: RRset
  readonly serial: number
  /** SOA in presentation form: needed for refresh/retry timers */
  readonly soaContent: string
  /** Enabled records excluding the SOA. */
  readonly recordCount: number
  /** The records an operator stored, without the DNSKEY and NSEC records DNSSEC adds */
  private readonly stored: RRset[]
  private readonly signer?: ZoneSigner
  private readonly chain?: NsecChain

  constructor(
    readonly apex: string,
    rrsets: RRset[],
    opts: { signer?: ZoneSigner } = {},
  ) {
    this.stored = rrsets
    this.signer = opts.signer
    for (const set of rrsets) {
      let types = this.byName.get(set.name)
      if (!types) this.byName.set(set.name, (types = new Map()))
      types.set(set.type, set)
      // Every name above an owner (down to the apex) exists, even if it has no records ("empty non-terminal")
      for (let n = parentOf(set.name); n !== '' && n !== apex && isAtOrBelow(n, apex); n = parentOf(n)) this.ancestors.add(n)
    }
    const soa = this.byName.get(apex)?.get(RType.SOA)
    if (!soa) throw new ValidationError(`zone ${apex} has no SOA record`)
    this.soa = soa
    this.serial = soaSerial(soa.rdatas[0]!)
    this.soaContent = soaToContent(soa.rdatas[0]!)
    this.recordCount = rrsets.reduce((n, r) => n + (r.type === RType.SOA ? 0 : r.rdatas.length), 0)

    if (this.signer) {
      // DNSKEY lives at the apex; NSEC records chain every name that owns authoritative data (not glue below a cut)
      this.byName.get(apex)!.set(RType.DNSKEY, { name: apex, type: RType.DNSKEY, ttl: soa.ttl, rdatas: this.signer.dnskeys() })
      const names = [...this.byName.keys()].filter((n) => {
        const cut = this.findDelegation(n)
        return !cut || cut.name === n
      })
      this.chain = buildNsecChain(names, (n) => [...this.byName.get(n)!.keys()], soaMinimum(soa.rdatas[0]!))
      for (const e of this.chain.entries) this.byName.get(e.name)!.set(RType.NSEC, e.rrset as RRset)
    }
  }

  get signed(): boolean {
    return this.signer !== undefined
  }

  /** RRSIG rdata covering `set` (one per active key). Empty for an unsigned zone. */
  signatures(set: RRset): Buffer[] {
    return this.signer ? this.signer.signatures(set) : []
  }

  /** The NSEC owned by `name`, if any (proves which types exist there, and so which do not). */
  nsecAt(name: string): RRset | undefined {
    return this.chain?.matching(name)?.rrset as RRset | undefined
  }

  /** The NSEC whose span contains `name` (proves `name` does not exist). */
  nsecCovering(name: string): RRset | undefined {
    return this.chain?.covering(name).rrset as RRset | undefined
  }

  /** The longest existing ancestor of `name` (RFC 4592): the apex at the least. */
  closestEncloser(name: string): string {
    let n = parentOf(name)
    while (n !== this.apex && !this.byName.has(n) && !this.ancestors.has(n)) n = parentOf(n)
    return n
  }

  contains(name: string): boolean {
    return isAtOrBelow(name, this.apex)
  }

  rrsets(name: string): Map<number, RRset> | undefined {
    return this.byName.get(name)
  }

  hasDescendants(name: string): boolean {
    return this.ancestors.has(name)
  }

  /** Nearest NS cut strictly below the apex on the path to `name` (inclusive), if any. */
  findDelegation(name: string): Delegation | undefined {
    const ls = labelsOf(name)
    for (let i = ls.length - labelsOf(this.apex).length - 1; i >= 0; i--) {
      const candidate = ls.slice(i).join('.')
      const ns = this.byName.get(candidate)?.get(RType.NS)
      if (ns) return { name: candidate, ns }
    }
    return undefined
  }

  /** Wildcard rrsets that synthesise answers for a non-existent `name` (RFC 4592). */
  wildcardFor(name: string): { owner: string; sets: Map<number, RRset> } | undefined {
    const owner = `*.${this.closestEncloser(name)}`
    const sets = this.byName.get(owner)
    return sets && { owner, sets }
  }

  allRRsets(): RRset[] {
    return this.stored
  }
}

/** Validates and compiles stored rrsets into a Zone. Throws ValidationError on bad data. */
export function buildZone(apex: string, inputs: RRsetInput[], opts: { signer?: ZoneSigner } = {}): Zone {
  return new Zone(
    apex,
    inputs.map((i) => compileRRset(apex, i)),
    opts,
  )
}

export function compileRRset(apex: string, input: RRsetInput): RRset {
  const name = normalizeName(input.name)
  validateName(name, { allowWildcard: true })
  if (!isAtOrBelow(name, apex)) throw new ValidationError(`${name} is outside zone ${apex}`)
  if (!Number.isInteger(input.ttl) || input.ttl < 0 || input.ttl > 2147483647) throw new ValidationError('TTL must be 0-2147483647')
  if (input.contents.length === 0) throw new ValidationError(`${input.type} ${name} has no records`)
  if ((input.type === 'CNAME' || input.type === 'SOA') && input.contents.length > 1) {
    throw new ValidationError(`${input.type} ${name} can only have one record`)
  }
  if (input.type === 'SOA' && name !== apex) throw new ValidationError('SOA is only allowed at the zone apex')
  if (input.type === 'CNAME' && name === apex) throw new ValidationError('CNAME is not allowed at the zone apex')
  const type = typeNumber(input.type)!
  return { name, type, ttl: input.ttl, rdatas: input.contents.map((c) => encodeRdata(input.type, c)) }
}

/** CNAME may not coexist with any other record at the same name (RFC 1034 3.6.2). */
export function assertNoCnameConflict(name: string, types: Iterable<string>, incoming: string): void {
  const all = new Set([...types, incoming])
  if (all.has('CNAME') && all.size > 1) {
    throw new ValidationError(`${name} cannot have a CNAME together with other record types`)
  }
}

export { typeName }
