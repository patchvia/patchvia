import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildZoneFile, fqdn, rdata } from './convert.mjs'

test('names become absolute and lower case', () => {
  assert.equal(fqdn('WWW.Example.com'), 'www.example.com.')
  assert.equal(fqdn('example.com.'), 'example.com.')
  assert.equal(fqdn(''), '.')
})

test('MX and SRV accept the priority inside content (PowerDNS 4) or in the prio column (older)', () => {
  assert.equal(rdata('MX', '10 mail.example.com', null), '10 mail.example.com.')
  assert.equal(rdata('MX', 'mail.example.com', 20), '20 mail.example.com.')
  assert.equal(rdata('SRV', '10 5 5060 sip.example.com', null), '10 5 5060 sip.example.com.')
  assert.equal(rdata('SRV', '5 5060 sip.example.com', 10), '10 5 5060 sip.example.com.')
  assert.equal(rdata('MX', 'mail.example.com', null), null) // no priority anywhere
})

test('host-name targets get a trailing dot so they are not read as relative', () => {
  assert.equal(rdata('CNAME', 'Example.com', 0), 'example.com.')
  assert.equal(rdata('NS', 'ns1.example.net', null), 'ns1.example.net.')
  assert.equal(rdata('PTR', 'host.example.com.', null), 'host.example.com.')
})

test('TXT keeps quoting, adds it when missing, and does not lowercase the text', () => {
  assert.equal(rdata('TXT', '"v=spf1 -all"', null), '"v=spf1 -all"')
  assert.equal(rdata('TXT', 'Hello "x"', null), '"Hello \\"x\\""')
  assert.equal(rdata('TXT', '"part one" "part two"', null), '"part one" "part two"')
})

test('A, AAAA and CAA pass through untouched', () => {
  assert.equal(rdata('A', '203.0.113.10', null), '203.0.113.10')
  assert.equal(rdata('AAAA', '2001:db8::1', null), '2001:db8::1')
  assert.equal(rdata('CAA', '0 issue "letsencrypt.org"', null), '0 issue "letsencrypt.org"')
})

test('SOA names become absolute', () => {
  assert.equal(rdata('SOA', 'ns1.example.com hostmaster.example.com 2026101501 10800 3600 604800 3600', null), 'ns1.example.com. hostmaster.example.com. 2026101501 10800 3600 604800 3600')
})

test('a zone file: SOA first, disabled records counted not copied, unusable ones reported', () => {
  const rows = [
    { name: 'www.example.com', type: 'CNAME', content: 'example.com', ttl: 300, prio: 0, disabled: 0 },
    { name: 'example.com', type: 'A', content: '203.0.113.10', ttl: 300, prio: 0, disabled: 0 },
    { name: 'example.com', type: 'SOA', content: 'ns1.example.com hostmaster.example.com 7 10800 3600 604800 3600', ttl: 3600, prio: 0, disabled: 0 },
    { name: 'old.example.com', type: 'A', content: '203.0.113.77', ttl: 300, prio: 0, disabled: 1 },
    { name: 'bad.example.com', type: 'MX', content: 'mail.example.com', ttl: 300, prio: null, disabled: 0 },
    { name: 'empty.example.com', type: null, content: null, ttl: null, prio: null, disabled: 0 },
    { name: 'noconfttl.example.com', type: 'A', content: '203.0.113.5', ttl: null, prio: null, disabled: 0 },
  ]
  const out = buildZoneFile('Example.com', rows)
  assert.equal(out.records, 4)
  assert.equal(out.disabled, 1)
  assert.deepEqual(out.unusable, ['bad.example.com MX mail.example.com'])
  const lines = out.zonefile.trim().split('\n')
  assert.equal(lines[0], '$ORIGIN example.com.')
  assert.match(lines[1], /^example\.com\. 3600 IN SOA /)
  assert.ok(lines.includes('noconfttl.example.com. 3600 IN A 203.0.113.5'))
  assert.ok(lines.includes('www.example.com. 300 IN CNAME example.com.'))
  assert.ok(!out.zonefile.includes('203.0.113.77'))
})

test('the same rows always produce the same file', () => {
  const rows = [
    { name: 'b.example.com', type: 'A', content: '1.1.1.1', ttl: 60, prio: 0, disabled: 0 },
    { name: 'a.example.com', type: 'A', content: '2.2.2.2', ttl: 60, prio: 0, disabled: 0 },
  ]
  assert.equal(buildZoneFile('example.com', rows).zonefile, buildZoneFile('example.com', [...rows].reverse()).zonefile)
})

test('reports whether the zone has its own apex NS records, and what it does have', () => {
  const rows = [
    { name: 'example.com', type: 'A', content: '1.1.1.1', ttl: 60, prio: 0, disabled: 0 },
    { name: 'sub.example.com', type: 'NS', content: 'ns.other.net', ttl: 60, prio: 0, disabled: 0 }, // a delegation, not the apex
  ]
  const out = buildZoneFile('example.com', rows)
  assert.equal(out.apexNs, 0)
  assert.deepEqual(out.types, { A: 1, NS: 1 })
  assert.equal(buildZoneFile('example.com', [...rows, { name: 'Example.com', type: 'NS', content: 'ns1.example.com', ttl: 60, prio: 0, disabled: 0 }]).apexNs, 1)
})
