import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeQuery } from '../src/dns/codec.js'
import { handlePacket } from '../src/dns/handler.js'
import { nameToWire } from '../src/dns/names.js'
import { RCode, RType } from '../src/dns/types.js'
import { dnskeyRdata, dsRecords, generateKey, keyTag, type DnssecKey } from '../src/dnssec/keys.js'
import { NsecChain, bitmapTypes, buildNsecChain, canonicalCompare, typeBitmap } from '../src/dnssec/nsec.js'
import { parseRrsig, rrsigLabels, signRRset, verifyRRset } from '../src/dnssec/sign.js'
import { privateKeyObject } from '../src/dnssec/keys.js'
import { ZoneSigner } from '../src/dnssec/signer.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { buildZone, type RRsetInput } from '../src/zones/zone.js'
import { parseResponse, type Parsed, type ParsedRR } from './helpers.js'

const NOW = 1_800_000_000
const newKey = (over: Partial<DnssecKey> = {}): DnssecKey => ({ ...generateKey(), active: true, published: true, ...over })

describe('known answers from the RFCs', () => {
  it('key tag matches RFC 4034 section 5.4 (dskey.example.com, tag 60485)', () => {
    const pub = Buffer.from(
      'AQOeiiR0GOMYkDshWoSKz9XzfwJr1AYtsmx3TGkJaNXVbfi/2pHm822aJ5iI9BMzNXxeYCmZDRD99WYwYqUSdjMmmAphXdvxegXd/M5+X7OrzKBaMbCVdFLUUh6DhweJBjEVv5f2wwjM9XzcnOf+EPbtG9DMBmADjFDc2w/rljwvFw==',
      'base64',
    )
    expect(keyTag(dnskeyRdata(256, 5, pub))).toBe(60485)
  })

  it('canonical name order matches RFC 4034 section 6.1', () => {
    const expected = ['example', 'a.example', 'yljkjljk.a.example', 'z.a.example', 'zabc.a.example', 'z.example', '*.z.example']
    expect([...expected].reverse().sort(canonicalCompare)).toEqual(expected)
    expect(['x.z.com', 'a.y.com', 'y.com', 'z.com', 'b.z.com'].sort(canonicalCompare)).toEqual(['y.com', 'a.y.com', 'z.com', 'b.z.com', 'x.z.com'])
  })

  it('type bitmap matches the RFC 4034 section 4.3 example (A MX RRSIG NSEC TYPE1234)', () => {
    const got = typeBitmap([RType.A, RType.MX, RType.RRSIG, RType.NSEC, 1234]).toString('hex')
    expect(got).toBe('0006400100000003' + '041b' + '00'.repeat(26) + '20')
    expect(bitmapTypes(Buffer.from(got, 'hex'))).toEqual([1, 15, 46, 47, 1234])
  })

  it('CAA (type 257) lands in window 1', () => {
    expect(typeBitmap([257]).toString('hex')).toBe('01' + '01' + '40')
  })
})

describe('keys and DS', () => {
  const key = newKey()
  it('generates P-256 keys: 64-byte public key, flags 257, consistent key tag', () => {
    expect(key.publicKey).toHaveLength(64)
    expect(key.flags).toBe(257)
    expect(key.algorithm).toBe(13)
    expect(key.keyTag).toBe(keyTag(dnskeyRdata(key.flags, key.algorithm, key.publicKey)))
    expect(newKey().privateKeyPem).not.toBe(key.privateKeyPem)
  })

  it('DS digest is hash(owner wire || DNSKEY rdata) for SHA-256 and SHA-384', () => {
    const [d2, d4] = dsRecords('Example.COM'.toLowerCase(), key)
    const input = Buffer.concat([nameToWire('example.com'), dnskeyRdata(key.flags, key.algorithm, key.publicKey)])
    expect(d2).toMatchObject({ keyTag: key.keyTag, algorithm: 13, digestType: 2 })
    expect(d2!.digest).toBe(createHash('sha256').update(input).digest('hex').toUpperCase())
    expect(d4).toMatchObject({ digestType: 4 })
    expect(d4!.digest).toBe(createHash('sha384').update(input).digest('hex').toUpperCase())
    expect(d2!.digest).toHaveLength(64)
    expect(d4!.digest).toHaveLength(96)
  })
})

describe('RRSIG creation and verification', () => {
  const key = newKey()
  const pk = privateKeyObject(key.privateKeyPem)
  const set = (name: string, over: object = {}) => ({
    name,
    type: RType.A as number,
    ttl: 300,
    rdatas: [{ wire: Buffer.from([192, 0, 2, 2]) }, { wire: Buffer.from([192, 0, 2, 1]) }],
    ...over,
  })
  const win = { inception: NOW - 3600, expiration: NOW + 86400 }
  const sign = (s: ReturnType<typeof set>, signer = 'example.test') => signRRset({ algorithm: 13, keyTag: key.keyTag, privateKey: pk }, signer, s, win)

  it('produces a well-formed RRSIG that verifies, independent of rdata order', () => {
    const sig = sign(set('www.example.test'))
    const p = parseRrsig(sig)
    expect(p).toMatchObject({ covered: 1, algorithm: 13, labels: 3, originalTtl: 300, keyTag: key.keyTag, signer: 'example.test', expiration: NOW + 86400, inception: NOW - 3600 })
    expect(p.signature).toHaveLength(64)
    expect(verifyRRset(key, sig, set('www.example.test'), NOW)).toBeNull()
    const shuffled = set('www.example.test', { rdatas: [{ wire: Buffer.from([192, 0, 2, 1]) }, { wire: Buffer.from([192, 0, 2, 2]) }] })
    expect(verifyRRset(key, sig, shuffled, NOW)).toBeNull()
  })

  it('rejects tampered data, a changed TTL, the wrong key, and signatures outside their validity window', () => {
    const sig = sign(set('www.example.test'))
    expect(verifyRRset(key, sig, set('www.example.test', { rdatas: [{ wire: Buffer.from([192, 0, 2, 9]) }] }), NOW)).toMatch(/does not verify/)
    expect(verifyRRset(key, sig, set('other.example.test'), NOW)).toMatch(/does not verify/)
    expect(verifyRRset(newKey(), sig, set('www.example.test'), NOW)).toMatch(/key tag/)
    expect(verifyRRset(key, sig, set('www.example.test'), NOW + 86401)).toMatch(/expired/)
    expect(verifyRRset(key, sig, set('www.example.test'), NOW - 7200)).toMatch(/not yet valid/)
    expect(verifyRRset(key, sig, set('www.example.test', { type: RType.AAAA }), NOW)).toMatch(/different type/)
  })

  it('wildcard: the label count excludes the *, and an expanded name still verifies', () => {
    expect(rrsigLabels('*.dev.example.test')).toBe(3)
    expect(rrsigLabels('example.test')).toBe(2)
    const sig = sign(set('*.dev.example.test'))
    expect(verifyRRset(key, sig, set('a.dev.example.test'), NOW)).toBeNull()
    expect(verifyRRset(key, sig, set('x.y.dev.example.test'), NOW)).toBeNull()
    expect(verifyRRset(key, sig, set('a.other.example.test'), NOW)).toMatch(/does not verify/)
  })

  it('names are case-insensitive in the signed data only because we always sign lower case', () => {
    expect(verifyRRset(key, sign(set('www.example.test')), set('www.example.test'), NOW)).toBeNull()
  })
})

describe('NSEC chain', () => {
  const names = ['example.test', 'www.example.test', 'a.example.test', '*.dev.example.test', 'mail.example.test']
  const chain: NsecChain = buildNsecChain(names, (n) => (n === 'example.test' ? [RType.SOA, RType.NS, RType.A] : [RType.A]), 300)
  it('links names in canonical order and wraps back to the apex', () => {
    expect(chain.entries.map((e) => e.name)).toEqual(['example.test', 'a.example.test', '*.dev.example.test', 'mail.example.test', 'www.example.test'])
    expect(chain.entries.map((e) => e.next)).toEqual(['a.example.test', '*.dev.example.test', 'mail.example.test', 'www.example.test', 'example.test'])
  })
  it('lists the types present plus NSEC and RRSIG', () => {
    const rd = chain.matching('example.test')!.rrset.rdatas[0]!.wire
    const bitmap = rd.subarray(nameToWire('a.example.test').length)
    expect(bitmapTypes(bitmap)).toEqual([RType.A, RType.NS, RType.SOA, RType.RRSIG, RType.NSEC].sort((a, b) => a - b))
  })
  it('finds the covering NSEC for names that do not exist', () => {
    expect(chain.covering('b.example.test').name).toBe('a.example.test')
    expect(chain.covering('zzz.example.test').name).toBe('www.example.test') // after the last name: the one that wraps
    expect(chain.covering('example.test').name).toBe('example.test')
    expect(chain.matching('nope.example.test')).toBeUndefined()
  })
})

// ---- end to end through the resolver, verified with the independent verifier --------------------------------------

const rs = (name: string, type: RRsetInput['type'], contents: string[], ttl = 300): RRsetInput => ({ name, type, ttl, contents })
const ZONE = 'sig.test'
const key = newKey()
const idx = new ZoneIndex()
const zone = buildZone(
  ZONE,
  [
    rs(ZONE, 'SOA', [`ns1.${ZONE} hostmaster.${ZONE} 2026101500 7200 3600 604800 120`], 3600),
    rs(ZONE, 'NS', [`ns1.${ZONE}`], 3600),
    rs(`ns1.${ZONE}`, 'A', ['192.0.2.53']),
    rs(ZONE, 'A', ['192.0.2.1']),
    rs(ZONE, 'MX', [`10 mail.${ZONE}`]),
    rs(`mail.${ZONE}`, 'A', ['192.0.2.25']),
    rs(`www.${ZONE}`, 'CNAME', [ZONE]),
    rs(`*.dev.${ZONE}`, 'A', ['192.0.2.99'], 60),
    rs(`a.b.c.${ZONE}`, 'A', ['192.0.2.7']),
    rs(`sub.${ZONE}`, 'NS', [`ns.sub.${ZONE}`]),
    rs(`ns.sub.${ZONE}`, 'A', ['192.0.2.77']),
  ],
  { signer: new ZoneSigner(ZONE, [key], { now: () => NOW }) },
)
idx.set(zone)

function ask(name: string, type: number, opts: { do?: boolean } = { do: true }): Parsed {
  const out = handlePacket(idx, encodeQuery(7, name, type, { edns: 4096, do: opts.do }), 'tcp')
  return parseResponse(out!)
}

const wire = (rr: ParsedRR) => ({ wire: rr.rdata })
const typesIn = (rrs: ParsedRR[]) => rrs.map((r) => r.type)

/** Every non-RRSIG RRset in the response must be covered by an RRSIG that verifies against our DNSKEY. */
function expectAllSigned(res: Parsed, sections: ('answers' | 'authority')[] = ['answers', 'authority']) {
  for (const section of sections) {
    const rrs = res[section]
    const groups = new Map<string, ParsedRR[]>()
    for (const r of rrs.filter((x) => x.type !== RType.RRSIG)) groups.set(`${r.name.toLowerCase()}|${r.type}`, [...(groups.get(`${r.name.toLowerCase()}|${r.type}`) ?? []), r])
    for (const [k, members] of groups) {
      const [name, type] = [k.split('|')[0]!, Number(k.split('|')[1])]
      if (members[0]!.type === RType.NS && section === 'authority' && !res.aa) continue // delegation NS is not signed
      const sigs = rrs.filter((x) => x.type === RType.RRSIG && x.name.toLowerCase() === name && parseRrsig(x.rdata).covered === type)
      expect(sigs.length, `no RRSIG for ${name} type ${type}`).toBeGreaterThan(0)
      const set = { name, type, ttl: parseRrsig(sigs[0]!.rdata).originalTtl, rdatas: members.map(wire) }
      for (const s of sigs) expect(verifyRRset(key, s.rdata, set, NOW), `${name}/${type}`).toBeNull()
    }
  }
}

const nsecRanges = (res: Parsed) =>
  res.authority.filter((r) => r.type === RType.NSEC).map((r) => ({ owner: r.name.toLowerCase(), next: r.text }))

describe('signed zone through the resolver', () => {
  it('positive answer carries a verifying RRSIG, and the DO bit is echoed', () => {
    const r = ask(ZONE, RType.A)
    expect(typesIn(r.answers)).toEqual([RType.A, RType.RRSIG])
    expectAllSigned(r)
    expect(r.aa).toBe(true)
  })

  it('without DO nothing DNSSEC-related appears (no RRSIG, no NSEC)', () => {
    for (const [n, t] of [[ZONE, RType.A], [`nope.${ZONE}`, RType.A], [ZONE, RType.MX]] as const) {
      const r = ask(n, t, { do: false })
      expect([...r.answers, ...r.authority].some((x) => x.type === RType.RRSIG || x.type === RType.NSEC)).toBe(false)
    }
  })

  it('serves the DNSKEY RRset with its signature, matching the configured key', () => {
    const r = ask(ZONE, RType.DNSKEY)
    expect(typesIn(r.answers)).toEqual([RType.DNSKEY, RType.RRSIG])
    expect(r.answers[0]!.rdata.equals(dnskeyRdata(key.flags, key.algorithm, key.publicKey))).toBe(true)
    expectAllSigned(r)
  })

  it('NODATA: signed SOA plus the NSEC at the name, whose bitmap omits the asked type', () => {
    const r = ask(`mail.${ZONE}`, RType.AAAA)
    expect(r.rcode).toBe(RCode.NOERROR)
    expect(r.answers).toHaveLength(0)
    expect(r.authority.map((x) => x.type).sort()).toEqual([RType.SOA, RType.NSEC, RType.RRSIG, RType.RRSIG].sort())
    expectAllSigned(r)
    const nsec = r.authority.find((x) => x.type === RType.NSEC)!
    expect(nsec.name.toLowerCase()).toBe(`mail.${ZONE}`)
    const bitmap = nsec.rdata.subarray(nameToWire(nsec.text).length)
    expect(bitmapTypes(bitmap)).toContain(RType.A)
    expect(bitmapTypes(bitmap)).not.toContain(RType.AAAA)
  })

  it('NXDOMAIN: SOA, an NSEC covering the name, and an NSEC proving no wildcard at the closest encloser', () => {
    const r = ask(`nope.${ZONE}`, RType.A)
    expect(r.rcode).toBe(RCode.NXDOMAIN)
    expectAllSigned(r)
    const ranges = nsecRanges(r)
    const covers = (name: string) => ranges.some((x) => canonicalCompare(x.owner, name) < 0 && (canonicalCompare(name, x.next) < 0 || canonicalCompare(x.next, x.owner) <= 0))
    expect(covers(`nope.${ZONE}`)).toBe(true)
    expect(covers(`*.${ZONE}`)).toBe(true) // closest encloser is the apex
  })

  it('NXDOMAIN below an existing branch proves the wildcard at that branch, not at the apex', () => {
    const r = ask(`x.b.c.${ZONE}`.replace('x.b', 'x.y'), RType.A) // y.c does not exist; closest encloser is c.sig.test (an empty non-terminal)
    expect(r.rcode).toBe(RCode.NXDOMAIN)
    expectAllSigned(r)
    const ranges = nsecRanges(r)
    const covers = (name: string) => ranges.some((x) => canonicalCompare(x.owner, name) < 0 && (canonicalCompare(name, x.next) < 0 || canonicalCompare(x.next, x.owner) <= 0))
    expect(covers(`*.c.${ZONE}`)).toBe(true)
  })

  it('wildcard answer: owner is the query name, the RRSIG labels exclude the *, and an NSEC proves nothing closer exists', () => {
    const r = ask(`host.dev.${ZONE}`, RType.A)
    expect(r.rcode).toBe(RCode.NOERROR)
    const a = r.answers.find((x) => x.type === RType.A)!
    expect(a.name.toLowerCase()).toBe(`host.dev.${ZONE}`)
    const sig = r.answers.find((x) => x.type === RType.RRSIG)!
    expect(parseRrsig(sig.rdata).labels).toBe(3) // dev.sig.test
    expectAllSigned(r, ['answers']) // verifies after undoing the expansion
    const nsec = nsecRanges(r)
    expect(nsec.length).toBeGreaterThan(0)
    expect(nsec.some((x) => canonicalCompare(x.owner, `host.dev.${ZONE}`) < 0 && canonicalCompare(`host.dev.${ZONE}`, x.next) < 0)).toBe(true)
  })

  it('wildcard NODATA proves the wildcard owns no such type, and that the name itself is absent', () => {
    const r = ask(`host.dev.${ZONE}`, RType.MX)
    expect(r.rcode).toBe(RCode.NOERROR)
    expect(r.answers).toHaveLength(0)
    const owners = nsecRanges(r).map((x) => x.owner)
    expect(owners).toContain(`*.dev.${ZONE}`)
    expect(owners.length).toBeGreaterThanOrEqual(1)
    expectAllSigned(r)
  })

  it('CNAME answers sign each RRset in the chain', () => {
    const r = ask(`www.${ZONE}`, RType.A)
    expect(r.answers.filter((x) => x.type === RType.CNAME)).toHaveLength(1)
    expect(r.answers.filter((x) => x.type === RType.A)).toHaveLength(1)
    expect(r.answers.filter((x) => x.type === RType.RRSIG)).toHaveLength(2)
    expectAllSigned(r)
  })

  it('empty non-terminal: NODATA with a covering NSEC', () => {
    const r = ask(`b.c.${ZONE}`, RType.A)
    expect(r.rcode).toBe(RCode.NOERROR)
    expect(r.answers).toHaveLength(0)
    expect(r.authority.some((x) => x.type === RType.NSEC)).toBe(true)
    expectAllSigned(r)
  })

  it('delegation: unsigned NS referral with an NSEC at the cut proving there is no DS (insecure child)', () => {
    const r = ask(`host.sub.${ZONE}`, RType.A)
    expect(r.aa).toBe(false)
    expect(r.answers).toHaveLength(0)
    const nsec = r.authority.find((x) => x.type === RType.NSEC)!
    expect(nsec.name.toLowerCase()).toBe(`sub.${ZONE}`)
    const types = bitmapTypes(nsec.rdata.subarray(nameToWire(nsec.text).length))
    expect(types).toContain(RType.NS)
    expect(types).not.toContain(RType.DS)
    expect(r.authority.filter((x) => x.type === RType.NS)).toHaveLength(1)
    expect(r.authority.some((x) => x.type === RType.RRSIG && parseRrsig(x.rdata).covered === RType.NS)).toBe(false)
    const sig = r.authority.find((x) => x.type === RType.RRSIG && parseRrsig(x.rdata).covered === RType.NSEC)!
    expect(verifyRRset(key, sig.rdata, { name: nsec.name.toLowerCase(), type: RType.NSEC, ttl: parseRrsig(sig.rdata).originalTtl, rdatas: [wire(nsec)] }, NOW)).toBeNull()
  })

  it('a DS query at a delegation is answered authoritatively with NODATA and the NSEC', () => {
    const r = ask(`sub.${ZONE}`, RType.DS)
    expect(r.aa).toBe(true)
    expect(r.rcode).toBe(RCode.NOERROR)
    expect(r.answers).toHaveLength(0)
    expect(r.authority.some((x) => x.type === RType.NSEC && x.name.toLowerCase() === `sub.${ZONE}`)).toBe(true)
  })

  it('negative TTLs: SOA and its signature are capped at the SOA minimum', () => {
    const r = ask(`nope.${ZONE}`, RType.A)
    for (const x of r.authority.filter((y) => y.type === RType.SOA || (y.type === RType.RRSIG && parseRrsig(y.rdata).covered === RType.SOA))) expect(x.ttl).toBe(120)
    const soaSig = r.authority.find((x) => x.type === RType.RRSIG && parseRrsig(x.rdata).covered === RType.SOA)!
    expect(parseRrsig(soaSig.rdata).originalTtl).toBe(3600) // the signature still covers the original TTL
  })

  it('every name that owns data has exactly one NSEC, and glue below the cut has none', () => {
    const owners: string[] = (zone as unknown as { chain: { entries: { name: string }[] } }).chain.entries.map((e) => e.name)
    expect(owners).toContain(`sub.${ZONE}`)
    expect(owners).not.toContain(`ns.sub.${ZONE}`)
    expect(owners).toContain(`*.dev.${ZONE}`)
    expect(new Set(owners).size).toBe(owners.length)
  })

  it('an unsigned zone ignores DO entirely', () => {
    const plain = new ZoneIndex()
    plain.set(buildZone('plain.test', [rs('plain.test', 'SOA', ['ns.plain.test h.plain.test 1 1 1 1 60']), rs('plain.test', 'NS', ['ns.plain.test']), rs('plain.test', 'A', ['192.0.2.1'])]))
    const r = parseResponse(handlePacket(plain, encodeQuery(1, 'plain.test', RType.A, { edns: 4096, do: true }), 'tcp')!)
    expect(typesIn(r.answers)).toEqual([RType.A])
  })
})

describe('signing behaviour', () => {
  it('caches signatures per RRset and renews them after the renewal age', () => {
    let t = NOW
    const signer = new ZoneSigner('c.test', [key], { now: () => t, renewAfterSeconds: 100 })
    const set = { name: 'c.test', type: 1, ttl: 60, rdatas: [{ wire: Buffer.from([1, 2, 3, 4]) }] }
    const a = signer.signatures(set)
    expect(signer.signatures(set)).toBe(a) // same cached array
    t += 101
    const b = signer.signatures(set)
    expect(b).not.toBe(a)
    expect(parseRrsig(b[0]!).inception).toBe(t - 3600)
  })

  it('signs with every active key, publishes every published key, and refuses to run without an active key', () => {
    const k1 = newKey()
    const k2 = newKey({ active: false })
    const k3 = newKey({ published: true, active: true })
    const signer = new ZoneSigner('m.test', [k1, k2, k3], { now: () => NOW })
    expect(signer.dnskeys()).toHaveLength(3)
    const set = { name: 'm.test', type: 1, ttl: 60, rdatas: [{ wire: Buffer.from([1, 2, 3, 4]) }] }
    expect(signer.signatures(set).map((s) => parseRrsig(s).keyTag).sort()).toEqual([k1.keyTag, k3.keyTag].sort())
    expect(() => new ZoneSigner('m.test', [newKey({ active: false })])).toThrow(/active key/)
    const unpublished = new ZoneSigner('m.test', [k1, newKey({ published: false, active: false })], { now: () => NOW })
    expect(unpublished.dnskeys()).toHaveLength(1)
  })
})

import { compileAcl } from '../src/common/cidr.js'
import { decodeMessage } from '../src/dns/decode.js'
import { handleMessages } from '../src/dns/handler.js'
import { transferPolicy } from '../src/dns/transfer.js'

describe('signed zones are never transferred', () => {
  it('refuses AXFR for a signed zone but serves the same client an unsigned one', () => {
    const both = new ZoneIndex()
    both.set(zone)
    both.set(buildZone('open.test', [rs('open.test', 'SOA', ['ns.open.test h.open.test 1 1 1 1 60']), rs('open.test', 'NS', ['ns.open.test'])]))
    const policy = transferPolicy(both, compileAcl(['203.0.113.7']))
    const axfr = (name: string) => decodeMessage(handleMessages(both, encodeQuery(1, name, RType.AXFR), 'tcp', '203.0.113.7', { transfers: policy })[0]!)
    expect(axfr(ZONE).rcode).toBe(RCode.REFUSED)
    expect(axfr('open.test').rcode).toBe(RCode.NOERROR)
  })
})
