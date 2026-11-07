import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.js'
import { parseTtl, parseZoneFile } from '../src/zones/zonefile-parser.js'
import { exportZoneFile } from '../src/zones/zonefile.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ZoneService } from '../src/zones/zone-service.js'

const BIND = `
; Zone file for example.com
$ORIGIN example.com.
$TTL 1h
@       IN  SOA ns1.example.com. hostmaster.example.com. (
                2026101501 ; serial
                2h         ; refresh
                30m        ; retry
                1w         ; expire
                5m )       ; minimum
        IN  NS  ns1
        IN  NS  ns2.example.net.
        IN  A   192.0.2.10
            A   192.0.2.11
        300 IN AAAA 2001:db8::10
        MX  10 mail
        MX  20 mail2.example.com.
        TXT "v=spf1 mx -all"
        TXT "part one " "part two; with semicolon" bareword
        TXT "has \\"quotes\\" and a \\\\ backslash"
        CAA 0 issue "letsencrypt.org"
ns1     A   192.0.2.53
www 5m  CNAME @
mail    A   192.0.2.25
_sip._tcp SRV 10 5 5060 sip
sip     A   192.0.2.5
*.apps  60 A 192.0.2.99
sub     NS  ns.sub
ns.sub  A   192.0.2.77
@       DNSKEY 257 3 13 AAAABBBB==
@       RRSIG  A 13 2 3600 20261231000000 20261201000000 1234 example.com. ZZZ
`

const sets = (p: ReturnType<typeof parseZoneFile>) => Object.fromEntries(p.rrsets.map((s) => [`${s.name} ${s.type}`, s]))

describe('parseTtl', () => {
  it.each([
    ['300', 300],
    ['1h', 3600],
    ['1h30m', 5400],
    ['2W', 1209600],
    ['1d12h', 129600],
    ['5m', 300],
  ])('%s', (input, seconds) => expect(parseTtl(input)).toBe(seconds))
  it.each(['', 'h', '1x', 'abc', '99999999999'])('rejects %j', (input) => expect(parseTtl(input)).toBeUndefined())
})

describe('parseZoneFile: a realistic BIND file', () => {
  const p = parseZoneFile(BIND)
  const s = sets(p)

  it('parses without errors and finds the origin', () => {
    expect(p.errors).toEqual([])
    expect(p.origin).toBe('example.com')
  })

  it('handles multi-line SOA with comments and TTL units', () => {
    expect(s['example.com SOA']).toMatchObject({
      ttl: 3600,
      contents: ['ns1.example.com hostmaster.example.com 2026101501 7200 1800 604800 300'],
    })
  })

  it('inherits owners from blank-led lines, resolves relative names and @', () => {
    expect(s['example.com NS']!.contents).toEqual(['ns1.example.com', 'ns2.example.net'])
    expect(s['example.com A']!.contents).toEqual(['192.0.2.10', '192.0.2.11'])
    expect(s['example.com MX']!.contents).toEqual(['10 mail.example.com', '20 mail2.example.com'])
    expect(s['www.example.com CNAME']).toMatchObject({ ttl: 300, contents: ['example.com'] })
    expect(s['_sip._tcp.example.com SRV']!.contents).toEqual(['10 5 5060 sip.example.com'])
    expect(s['sub.example.com NS']!.contents).toEqual(['ns.sub.example.com'])
  })

  it('applies $TTL, explicit TTLs and wildcard owners', () => {
    expect(s['example.com A']!.ttl).toBe(3600)
    expect(s['example.com AAAA']).toMatchObject({ ttl: 300, contents: ['2001:db8::10'] })
    expect(s['*.apps.example.com A']).toMatchObject({ ttl: 60, contents: ['192.0.2.99'] })
  })

  it('keeps TXT strings intact: semicolons in quotes, escapes, bare words', () => {
    expect(s['example.com TXT']!.contents).toEqual([
      '"v=spf1 mx -all"',
      '"part one " "part two; with semicolon" "bareword"',
      '"has \\"quotes\\" and a \\\\ backslash"',
    ])
    expect(s['example.com CAA']!.contents).toEqual(['0 issue "letsencrypt.org"'])
  })

  it('counts types the server does not serve instead of failing', () => {
    expect(p.skipped).toEqual({ DNSKEY: 1, RRSIG: 1 })
  })

  it('produces content the server accepts', () => {
    const db = openDatabase(':memory:')
    const svc = new ZoneService(new ZoneRepository(db), new ZoneIndex())
    svc.createZone({ name: 'example.com', nameservers: ['ns1.example.com'] })
    expect(() => svc.replaceContents('example.com', p.rrsets)).not.toThrow()
    expect(svc.getZone('example.com').serial).toBe(2026101501)
    expect(svc.getZone('example.com').recordCount).toBe(p.rrsets.filter((r) => r.type !== 'SOA').reduce((n, r) => n + r.contents.length, 0))
  })
})

describe('parseZoneFile: details', () => {
  it('takes the origin from the caller when the file has no $ORIGIN', () => {
    const p = parseZoneFile('@ 300 IN A 192.0.2.1\nwww CNAME @\n', { origin: 'Example.ORG' })
    expect(p.errors).toEqual([])
    expect(sets(p)['example.org A']!.contents).toEqual(['192.0.2.1'])
    expect(sets(p)['www.example.org CNAME']!.contents).toEqual(['example.org'])
  })

  it('accepts class and TTL in either order, and absolute names without an origin', () => {
    const p = parseZoneFile('a.example. IN 120 A 1.1.1.1\nb.example. 120 IN A 2.2.2.2\n')
    expect(p.errors).toEqual([])
    expect(p.rrsets.map((r) => r.ttl)).toEqual([120, 120])
  })

  it('uses the lowest TTL when records of one RRset disagree, and warns', () => {
    const p = parseZoneFile('$ORIGIN z.test.\n@ 300 A 1.1.1.1\n@ 60 A 2.2.2.2\n')
    expect(p.rrsets[0]!.ttl).toBe(60)
    expect(p.warnings[0]!.message).toMatch(/different TTLs/)
  })

  it('removes duplicate records and skips names outside the zone with a warning', () => {
    const p = parseZoneFile('$ORIGIN z.test.\n@ A 1.1.1.1\n@ A 1.1.1.1\nother.example. A 2.2.2.2\n')
    expect(p.rrsets).toHaveLength(1)
    expect(p.rrsets[0]!.contents).toEqual(['1.1.1.1'])
    expect(p.skipped['out-of-zone']).toBe(1)
    expect(p.warnings.some((w) => /outside z\.test/.test(w.message))).toBe(true)
  })

  it('handles CRLF line endings and a missing trailing newline', () => {
    const p = parseZoneFile('$ORIGIN z.test.\r\n@ A 1.1.1.1\r\nwww A 2.2.2.2')
    expect(p.errors).toEqual([])
    expect(p.rrsets).toHaveLength(2)
  })

  it('treats an empty file as an empty zone', () => {
    expect(parseZoneFile('  \n; only a comment\n').rrsets).toEqual([])
  })
})

describe('parseZoneFile: errors carry line numbers', () => {
  const errs = (text: string, origin?: string) => parseZoneFile(text, { origin }).errors

  it('relative names without an origin', () => {
    expect(errs('www A 1.1.1.1\n')).toEqual([{ line: 1, message: 'relative name "www" but no $ORIGIN is set' }])
    expect(errs('$ORIGIN z.test.\n\n@ A 1.1.1.1\n  \n')).toEqual([])
  })
  it('unsupported directives and classes', () => {
    expect(errs('$INCLUDE other.zone\n')[0]).toMatchObject({ line: 1, message: expect.stringMatching(/not supported/) })
    expect(errs('$GENERATE 1-5 h$ A 1.1.1.$\n')[0]!.message).toMatch(/not supported/)
    expect(errs('a.z. CH TXT "x"\n')[0]!.message).toMatch(/class CH/)
  })
  it('malformed records are reported with their line', () => {
    expect(errs('$ORIGIN z.test.\n@ A\n')[0]).toMatchObject({ line: 2, message: expect.stringMatching(/exactly one address/) })
    expect(errs('$ORIGIN z.test.\n@ MX mail\n')[0]!.message).toMatch(/MX needs/)
    expect(errs('$ORIGIN z.test.\n@ SOA a b 1 2 3\n')[0]!.message).toMatch(/SOA needs/)
    expect(errs('$ORIGIN z.test.\n@ SOA a b x 1 1 1 1\n')[0]!.message).toMatch(/must be numbers/)
  })
  it('unterminated strings and unbalanced parentheses', () => {
    expect(errs('$ORIGIN z.test.\n@ TXT "oops\n')[0]!.message).toMatch(/unterminated/)
    expect(errs('$ORIGIN z.test.\n@ SOA ( a b 1 1 1 1 1\n')[0]!.message).toMatch(/unclosed/)
    expect(errs('$ORIGIN z.test.\n@ A 1.1.1.1 )\n')[0]!.message).toMatch(/unbalanced/)
  })
  it('invalid content is caught using the server rules', () => {
    expect(errs('$ORIGIN z.test.\n@ A 999.1.1.1\n')[0]!.message).toMatch(/invalid IPv4/)
    expect(errs('$ORIGIN z.test.\nbad_name!.z.test. A 1.1.1.1\n').length).toBeGreaterThan(0)
  })
  it('CNAME rules', () => {
    expect(errs('$ORIGIN z.test.\nx CNAME a\nx A 1.1.1.1\n')[0]!.message).toMatch(/CNAME together with other/)
    expect(errs('$ORIGIN z.test.\n@ CNAME a\n')[0]!.message).toMatch(/apex/)
    expect(errs('$ORIGIN z.test.\nx CNAME a\nx CNAME b\n')[0]!.message).toMatch(/more than one CNAME/)
  })
  it('an owner-less first record', () => {
    expect(errs('  A 1.1.1.1\n')[0]!.message).toMatch(/no owner/)
  })
})

describe('round trip with the exporter', () => {
  it('re-importing an exported zone yields the same records', () => {
    const db = openDatabase(':memory:')
    const svc = new ZoneService(new ZoneRepository(db), new ZoneIndex())
    svc.createZone({ name: 'rt.test', nameservers: ['ns1.rt.test', 'ns2.other.net'] })
    const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))
    svc.applyChanges('rt.test', [
      { name: 'rt.test', type: 'A', changetype: 'REPLACE', ttl: 300, records: rec('192.0.2.1', '192.0.2.2') },
      { name: 'rt.test', type: 'AAAA', changetype: 'REPLACE', ttl: 300, records: rec('2001:db8::1') },
      { name: 'rt.test', type: 'MX', changetype: 'REPLACE', ttl: 3600, records: rec('10 mail.rt.test', '20 mx.other.net') },
      { name: 'rt.test', type: 'TXT', changetype: 'REPLACE', ttl: 3600, records: rec('"v=spf1 -all"', '"quote \\" and ; and \\\\"') },
      { name: 'rt.test', type: 'CAA', changetype: 'REPLACE', ttl: 3600, records: rec('0 issue "letsencrypt.org"') },
      { name: 'www.rt.test', type: 'CNAME', changetype: 'REPLACE', ttl: 60, records: rec('rt.test') },
      { name: '*.apps.rt.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('192.0.2.9') },
      { name: '_sip._tcp.rt.test', type: 'SRV', changetype: 'REPLACE', ttl: 3600, records: rec('10 5 5060 sip.rt.test') },
      { name: '4.3.2.1.in-addr.arpa.rt.test', type: 'PTR', changetype: 'REPLACE', ttl: 3600, records: rec('host.rt.test') },
    ])
    const stored = svc.getRRsets('rt.test')
    const parsed = parseZoneFile(exportZoneFile('rt.test', stored))
    expect(parsed.errors).toEqual([])
    const norm = (xs: { name: string; type: string; ttl: number; contents?: string[]; records?: { content: string }[] }[]) =>
      xs
        .map((x) => `${x.name} ${x.type} ${x.ttl} ${[...(x.contents ?? x.records!.map((r) => r.content))].sort().join(' | ')}`)
        .sort()
    expect(norm(parsed.rrsets)).toEqual(norm(stored))
  })
})
