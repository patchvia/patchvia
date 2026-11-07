import { soaMinimum } from './rdata.js'
import { OpCode, RClass, RCode, RType, type Query, type Question, type Response, type RR } from './types.js'
import type { RRset, Zone } from '../zones/zone.js'

/** EDNS0 payload size we advertise; 1232 avoids IP fragmentation (DNS flag day 2020). */
export const EDNS_PAYLOAD = 1232
const MAX_CNAME_HOPS = 8

export interface ZoneLookup {
  /** Most specific zone we are authoritative for that contains `name`. */
  findZone(name: string): Zone | undefined
}

function rrsOf(set: RRset, owner = set.name): RR[] {
  return set.rdatas.map((r) => ({ name: owner, type: set.type, ttl: set.ttl, rdata: r.wire }))
}

/** Builds one response. `dnssec` is true when the zone is signed and the client set the DO bit. */
class Answerer {
  constructor(
    private readonly zone: Zone,
    private readonly res: Response,
    private readonly dnssec: boolean,
  ) {}

  private sigs(set: RRset, owner: string, ttl = set.ttl): RR[] {
    return this.zone.signatures(set).map((rdata) => ({ name: owner, type: RType.RRSIG, ttl, rdata }))
  }

  /** Adds an RRset to a section, with its signatures when DNSSEC is in play. */
  private push(section: RR[], set: RRset, owner = set.name): void {
    section.push(...rrsOf(set, owner))
    if (this.dnssec) section.push(...this.sigs(set, owner))
  }

  private addSoa(): void {
    const soa = this.zone.soa
    // Negative caching TTL (RFC 2308): the lower of the SOA's TTL and its minimum field. Signatures carry the same TTL.
    const ttl = Math.min(soa.ttl, soaMinimum(soa.rdatas[0]!))
    this.res.authority.push({ name: this.zone.apex, type: RType.SOA, ttl, rdata: soa.rdatas[0]!.wire })
    if (this.dnssec) this.res.authority.push(...this.sigs(soa, this.zone.apex, ttl))
  }

  private addNsec(nsec: RRset | undefined): void {
    if (!this.dnssec || !nsec) return
    if (this.res.authority.some((r) => r.type === RType.NSEC && r.name === nsec.name)) return
    this.push(this.res.authority, nsec)
  }

  /** A/AAAA for MX/NS/SRV targets that live in this zone (including glue below a cut). */
  private addAdditional(set: RRset): void {
    if (set.type !== RType.MX && set.type !== RType.NS && set.type !== RType.SRV) return
    const seen = new Set(this.res.additional.map((r) => `${r.name}/${r.type}`))
    for (const { target } of set.rdatas) {
      if (!target || !this.zone.contains(target)) continue
      const sets = this.zone.rrsets(target)
      for (const t of [RType.A, RType.AAAA]) {
        const s = sets?.get(t)
        if (s && !seen.has(`${target}/${t}`)) {
          seen.add(`${target}/${t}`)
          this.res.additional.push(...rrsOf(s))
        }
      }
    }
  }

  /**
   * NODATA: the name exists (or a wildcard stands in for it) but has nothing of this type. The NSEC at the owner lists
   * its types, which proves it. An empty non-terminal owns no NSEC, so the covering one stands in.
   */
  private noData(qname: string, owner: string, viaWildcard: boolean): void {
    this.addSoa()
    if (!this.dnssec) return
    this.addNsec(this.zone.nsecAt(owner) ?? this.zone.nsecCovering(owner))
    if (viaWildcard) this.addNsec(this.zone.nsecCovering(qname)) // and nothing closer than the wildcard exists
  }

  /** NXDOMAIN needs two proofs: the name itself is absent, and no wildcard could have matched it (RFC 4035 3.1.3.2). */
  private nxDomain(qname: string): void {
    this.res.rcode = RCode.NXDOMAIN
    this.addSoa()
    if (!this.dnssec) return
    this.addNsec(this.zone.nsecCovering(qname))
    this.addNsec(this.zone.nsecCovering(`*.${this.zone.closestEncloser(qname)}`))
  }

  run(qu: Question): void {
    const { zone, res } = this
    res.aa = true
    let name = qu.name
    const visited = new Set<string>()
    for (let hop = 0; ; hop++) {
      const cut = zone.findDelegation(name)
      if (cut) {
        // A DS lives on the parent side of a cut: we hold none, and the NSEC at the cut proves it
        if (hop === 0 && qu.type === RType.DS && cut.name === name) return this.noData(name, name, false)
        // Inside a CNAME chain we just stop; the client restarts the lookup at the target.
        if (hop === 0) {
          res.aa = false
          res.authority.push(...rrsOf(cut.ns))
          // Unsigned delegation: the NSEC at the cut says there is no DS, so the child is genuinely insecure
          this.addNsec(zone.nsecAt(cut.name))
          this.addAdditional(cut.ns)
        }
        return
      }

      let sets = zone.rrsets(name)
      let wildcardOwner: string | undefined
      if (!sets) {
        if (zone.hasDescendants(name)) return this.noData(name, name, false) // empty non-terminal
        const w = zone.wildcardFor(name)
        if (!w) return this.nxDomain(name)
        sets = w.sets
        wildcardOwner = w.owner
      }

      // An expanded wildcard also needs proof that no name closer than the wildcard exists
      const proveNoCloser = (): void => {
        if (wildcardOwner !== undefined) this.addNsec(zone.nsecCovering(name))
      }

      const cname = sets.get(RType.CNAME)
      if (cname && qu.type !== RType.CNAME && qu.type !== RType.ANY) {
        this.push(res.answers, cname, name)
        proveNoCloser()
        const target = cname.rdatas[0]?.target
        visited.add(name)
        if (!target || !zone.contains(target) || visited.has(target) || hop >= MAX_CNAME_HOPS) return
        name = target
        continue
      }

      if (qu.type === RType.ANY) {
        for (const set of sets.values()) {
          if (set.type === RType.NSEC && !this.dnssec) continue
          this.push(res.answers, set, name)
        }
        return proveNoCloser()
      }

      const set = sets.get(qu.type)
      if (!set) return this.noData(name, wildcardOwner ?? name, wildcardOwner !== undefined)
      this.push(res.answers, set, name)
      proveNoCloser()
      this.addAdditional(set)
      return
    }
  }
}

/** Pure query resolution: no sockets, no I/O. */
export function resolve(zones: ZoneLookup, q: Query): Response {
  const res: Response = {
    id: q.id,
    opcode: q.opcode,
    aa: false,
    tc: false,
    rd: q.rd,
    cd: q.cd,
    rcode: RCode.NOERROR,
    questions: q.questions,
    answers: [],
    authority: [],
    additional: [],
    // RFC 3225: a server that understands DO echoes it
    edns: q.edns ? { payload: EDNS_PAYLOAD, do: q.edns.do } : undefined,
  }
  if (q.opcode !== OpCode.QUERY) return { ...res, questions: [], rcode: RCode.NOTIMP }
  if (q.edns && q.edns.version !== 0) return { ...res, rcode: RCode.BADVERS }
  const qu = q.questions[0]
  if (!qu || q.questions.length !== 1) return { ...res, questions: [], rcode: RCode.FORMERR }
  if (qu.class !== RClass.IN || qu.type === RType.AXFR || qu.type === RType.IXFR) return { ...res, rcode: RCode.REFUSED }
  if (qu.type === RType.OPT) return { ...res, rcode: RCode.FORMERR }
  const zone = zones.findZone(qu.name)
  if (!zone) return { ...res, rcode: RCode.REFUSED }
  new Answerer(zone, res, zone.signed && q.edns?.do === true).run(qu)
  return res
}
