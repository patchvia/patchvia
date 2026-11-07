import { describe, expect, it } from 'vitest'
import { RCode, RType } from '../src/dns/types.js'
import type { RRsetInput } from '../src/zones/zone.js'
import { ask, indexOf } from './helpers.js'

const r = (name: string, type: RRsetInput['type'], contents: string[], ttl = 300): RRsetInput => ({ name, type, ttl, contents })

const zone = indexOf('example.test', [
  r('example.test', 'SOA', ['ns1.example.test hostmaster.example.test 2026101401 10800 3600 604800 600'], 3600),
  r('example.test', 'NS', ['ns1.example.test', 'ns2.example.test'], 3600),
  r('ns1.example.test', 'A', ['192.0.2.53']),
  r('ns2.example.test', 'A', ['192.0.2.54']),
  r('ns2.example.test', 'AAAA', ['2001:db8::54']),
  r('example.test', 'A', ['192.0.2.10']),
  r('example.test', 'AAAA', ['2001:db8::10']),
  r('example.test', 'MX', ['10 mail.example.test', '20 mail2.example.test']),
  r('mail.example.test', 'A', ['192.0.2.25']),
  r('example.test', 'TXT', ['"v=spf1 mx" " -all"']),
  r('example.test', 'CAA', ['0 issue "letsencrypt.org"']),
  r('www.example.test', 'CNAME', ['example.test']),
  r('chain1.example.test', 'CNAME', ['chain2.example.test']),
  r('chain2.example.test', 'CNAME', ['www.example.test']),
  r('loop1.example.test', 'CNAME', ['loop2.example.test']),
  r('loop2.example.test', 'CNAME', ['loop1.example.test']),
  r('ext.example.test', 'CNAME', ['target.elsewhere.test']),
  r('*.dev.example.test', 'A', ['192.0.2.99'], 60),
  r('_sip._tcp.example.test', 'SRV', ['10 5 5060 sip.example.test']),
  r('sip.example.test', 'A', ['192.0.2.5']),
  r('sub.example.test', 'NS', ['ns.sub.example.test']),
  r('ns.sub.example.test', 'A', ['192.0.2.77']),
  r('a.b.c.example.test', 'A', ['192.0.2.1']),
])

describe('resolver', () => {
  it('answers A authoritatively', () => {
    const a = ask(zone, 'example.test', RType.A)
    expect(a.rcode).toBe(RCode.NOERROR)
    expect(a.aa).toBe(true)
    expect(a.answers.map((x) => x.text)).toEqual(['192.0.2.10'])
    expect(a.answers[0]!.ttl).toBe(300)
  })

  it('answers AAAA, TXT (multi-string), CAA, SRV', () => {
    expect(ask(zone, 'example.test', RType.AAAA).answers[0]!.text).toBe('2001:db8:0:0:0:0:0:10')
    expect(ask(zone, 'example.test', RType.TXT).answers[0]!.text).toBe('v=spf1 mx -all')
    expect(ask(zone, 'example.test', 257).answers[0]!.text).toBe('0 issue letsencrypt.org')
    expect(ask(zone, '_sip._tcp.example.test', RType.SRV).answers[0]!.text).toBe('10 5 5060 sip.example.test')
  })

  it('answers MX with glue in additional', () => {
    const a = ask(zone, 'example.test', RType.MX)
    expect(a.answers.map((x) => x.text).sort()).toEqual(['10 mail.example.test', '20 mail2.example.test'])
    expect(a.additional.map((x) => `${x.name} ${x.text}`)).toEqual(['mail.example.test 192.0.2.25'])
  })

  it('answers NS with A and AAAA glue', () => {
    const a = ask(zone, 'example.test', RType.NS)
    expect(a.additional.map((x) => x.text).sort()).toEqual(['192.0.2.53', '192.0.2.54', '2001:db8:0:0:0:0:0:54'])
  })

  it('is case-insensitive and echoes the question case (0x20)', () => {
    const a = ask(zone, 'ExAmPle.TeSt', RType.A)
    expect(a.question.name).toBe('ExAmPle.TeSt')
    expect(a.answers[0]!.name).toBe('ExAmPle.TeSt')
  })

  it('returns NODATA with SOA when the name exists but not the type', () => {
    const a = ask(zone, 'mail.example.test', RType.AAAA)
    expect(a.rcode).toBe(RCode.NOERROR)
    expect(a.answers).toHaveLength(0)
    expect(a.authority[0]!.type).toBe(RType.SOA)
    expect(a.authority[0]!.ttl).toBe(600) // min(soa ttl, minimum)
  })

  it('returns NXDOMAIN with SOA for missing names', () => {
    const a = ask(zone, 'nope.example.test', RType.A)
    expect(a.rcode).toBe(RCode.NXDOMAIN)
    expect(a.aa).toBe(true)
    expect(a.authority[0]!.type).toBe(RType.SOA)
  })

  it('treats empty non-terminals as NODATA, not NXDOMAIN', () => {
    expect(ask(zone, 'c.example.test', RType.A).rcode).toBe(RCode.NOERROR)
    expect(ask(zone, 'b.c.example.test', RType.A).rcode).toBe(RCode.NOERROR)
    expect(ask(zone, 'a.b.c.example.test', RType.A).answers).toHaveLength(1)
  })

  it('follows CNAME chains inside the zone', () => {
    const a = ask(zone, 'chain1.example.test', RType.A)
    expect(a.answers.map((x) => `${x.type}:${x.text}`)).toEqual([
      `${RType.CNAME}:chain2.example.test`,
      `${RType.CNAME}:www.example.test`,
      `${RType.CNAME}:example.test`,
      `${RType.A}:192.0.2.10`,
    ])
  })

  it('returns only the CNAME when asked for CNAME, and stops at out-of-zone targets', () => {
    expect(ask(zone, 'www.example.test', RType.CNAME).answers).toHaveLength(1)
    const ext = ask(zone, 'ext.example.test', RType.A)
    expect(ext.answers.map((x) => x.text)).toEqual(['target.elsewhere.test'])
    expect(ext.rcode).toBe(RCode.NOERROR)
  })

  it('survives CNAME loops', () => {
    const a = ask(zone, 'loop1.example.test', RType.A)
    expect(a.rcode).toBe(RCode.NOERROR)
    expect(a.answers.length).toBeLessThanOrEqual(3)
  })

  it('synthesises wildcard answers with the query name as owner', () => {
    const a = ask(zone, 'anything.dev.example.test', RType.A)
    expect(a.answers).toMatchObject([{ name: 'anything.dev.example.test', text: '192.0.2.99', ttl: 60 }])
    expect(ask(zone, 'x.y.dev.example.test', RType.A).answers[0]!.text).toBe('192.0.2.99')
  })

  it('wildcard gives NODATA for other types and does not match the encloser itself', () => {
    expect(ask(zone, 'anything.dev.example.test', RType.AAAA).answers).toHaveLength(0)
    expect(ask(zone, 'dev.example.test', RType.A).rcode).toBe(RCode.NOERROR) // ENT, NODATA
    expect(ask(zone, 'dev.example.test', RType.A).answers).toHaveLength(0)
  })

  it('returns referrals (not authoritative) with glue for delegated names', () => {
    const a = ask(zone, 'host.sub.example.test', RType.A)
    expect(a.aa).toBe(false)
    expect(a.rcode).toBe(RCode.NOERROR)
    expect(a.answers).toHaveLength(0)
    expect(a.authority.map((x) => x.text)).toEqual(['ns.sub.example.test'])
    expect(a.additional.map((x) => x.text)).toEqual(['192.0.2.77'])
  })

  it('answers ANY with all rrsets at the name', () => {
    const types = ask(zone, 'example.test', RType.ANY).answers.map((x) => x.type)
    expect(types).toEqual(expect.arrayContaining([RType.A, RType.AAAA, RType.MX, RType.NS, RType.SOA, RType.TXT]))
  })

  it('refuses names outside our zones, non-IN classes and AXFR', () => {
    expect(ask(zone, 'example.org', RType.A).rcode).toBe(RCode.REFUSED)
    expect(ask(zone, 'example.test', RType.AXFR).rcode).toBe(RCode.REFUSED)
  })

  it('answers SOA at the apex', () => {
    expect(ask(zone, 'example.test', RType.SOA).answers[0]!.text).toBe(
      'ns1.example.test hostmaster.example.test 2026101401 10800 3600 604800 600',
    )
  })
})

describe('EDNS and truncation', () => {
  it('echoes an OPT record when the query had one', () => {
    expect(ask(zone, 'example.test', RType.A, { edns: 4096 }).edns?.payload).toBe(1232)
    expect(ask(zone, 'example.test', RType.A).edns).toBeUndefined()
  })

  it('sets TC over UDP when the answer does not fit, but not over TCP', () => {
    const big = indexOf('big.test', [
      r('big.test', 'SOA', ['ns.big.test h.big.test 1 1 1 1 1']),
      r('big.test', 'NS', ['ns.big.test']),
      r(
        'big.test',
        'TXT',
        Array.from({ length: 12 }, (_, i) => `"${String(i).padStart(2, '0')}${'x'.repeat(60)}"`),
      ),
    ])
    const udp = ask(big, 'big.test', RType.TXT)
    expect(udp.tc).toBe(true)
    expect(udp.size).toBeLessThanOrEqual(512)
    const tcp = ask(big, 'big.test', RType.TXT, { transport: 'tcp' })
    expect(tcp.tc).toBe(false)
    expect(tcp.answers).toHaveLength(12)
    expect(ask(big, 'big.test', RType.TXT, { edns: 4096 }).tc).toBe(false) // fits in 1232
  })
})
