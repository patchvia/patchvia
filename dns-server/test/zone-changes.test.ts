import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.js'
import { AuditRepository } from '../src/zones/audit-repository.js'
import { exportZoneFile } from '../src/zones/zonefile.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ConflictError, ZoneService } from '../src/zones/zone-service.js'

function setup() {
  const db = openDatabase(':memory:')
  const index = new ZoneIndex()
  const audit = new AuditRepository(db)
  const svc = new ZoneService(new ZoneRepository(db), index, audit)
  svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] }, { actor: 'alice' })
  return { svc, index, audit, db }
}
const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))

describe('applyChanges', () => {
  it('is atomic: one bad change writes nothing and does not bump the serial', () => {
    const { svc, index } = setup()
    const before = index.get('a.test')!.serial
    expect(() =>
      svc.applyChanges('a.test', [
        { name: 'ok.a.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('1.1.1.1') },
        { name: 'bad.a.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('not-an-ip') },
      ]),
    ).toThrow()
    expect(svc.getRRsets('a.test').some((s) => s.name === 'ok.a.test')).toBe(false)
    expect(index.get('a.test')!.serial).toBe(before)
  })

  it('bumps the serial once for a multi-change batch', () => {
    const { svc, index } = setup()
    const before = index.get('a.test')!.serial
    svc.applyChanges('a.test', [
      { name: 'x.a.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('1.1.1.1') },
      { name: 'y.a.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('2.2.2.2') },
      { name: 'z.a.test', type: 'TXT', changetype: 'REPLACE', ttl: 60, records: rec('"hi"') },
    ])
    expect(index.get('a.test')!.serial).toBe(before + 1)
  })

  it('detects CNAME conflicts inside a single batch', () => {
    const { svc } = setup()
    expect(() =>
      svc.applyChanges('a.test', [
        { name: 'w.a.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('1.1.1.1') },
        { name: 'w.a.test', type: 'CNAME', changetype: 'REPLACE', ttl: 60, records: rec('a.test') },
      ]),
    ).toThrow(/CNAME/)
  })

  it('keeps an explicitly edited SOA serial instead of bumping over it', () => {
    const { svc, index } = setup()
    svc.applyChanges('a.test', [
      { name: 'a.test', type: 'SOA', changetype: 'REPLACE', ttl: 3600, records: rec('ns.a.test hostmaster.a.test 5000000000 1 1 1 1').slice(0, 0).concat(rec('ns.a.test hostmaster.a.test 3000000000 10800 3600 604800 3600')) },
    ])
    expect(index.get('a.test')!.serial).toBe(3000000000)
  })

  it('creates a zone with initial rrsets atomically', () => {
    const { svc } = setup()
    expect(() =>
      svc.createZone({
        name: 'b.test',
        nameservers: ['ns.b.test'],
        rrsets: [{ name: 'x.b.test', type: 'A', changetype: 'REPLACE', ttl: 60, records: rec('bad') }],
      }),
    ).toThrow()
    expect(svc.listZones().map((z) => z.name)).toEqual(['a.test'])
    expect(() => svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })).toThrow(ConflictError)
  })

  it('writes audit entries with before/after and the actor', () => {
    const { svc, audit } = setup()
    svc.setRRset('a.test', 'x.a.test', 'A', 60, rec('1.1.1.1'), { actor: 'bob' })
    svc.setRRset('a.test', 'x.a.test', 'A', 120, rec('2.2.2.2'), { actor: 'bob' })
    svc.deleteRRset('a.test', 'x.a.test', 'A', { actor: 'carol' })
    const log = audit.list({ zone: 'a.test' })
    expect(log.map((e) => `${e.actor}:${e.action}`)).toEqual(['carol:rrset.delete', 'bob:rrset.replace', 'bob:rrset.replace', 'alice:zone.create'])
    const second = log[1]!.detail as { before: { ttl: number }; after: { ttl: number } }
    expect(second.before.ttl).toBe(60)
    expect(second.after.ttl).toBe(120)
  })

  it('does not audit failed changes', () => {
    const { svc, audit } = setup()
    expect(() => svc.setRRset('a.test', 'x.a.test', 'A', 60, rec('nope'))).toThrow()
    expect(audit.list({ zone: 'a.test' })).toHaveLength(1)
  })
})

describe('zone file export', () => {
  it('writes SOA first, absolute names, quoted TXT, commented disabled records', () => {
    const { svc } = setup()
    svc.applyChanges('a.test', [
      { name: 'www.a.test', type: 'CNAME', changetype: 'REPLACE', ttl: 300, records: rec('a.test') },
      { name: 'a.test', type: 'MX', changetype: 'REPLACE', ttl: 300, records: rec('10 mail.a.test') },
      { name: 'a.test', type: 'TXT', changetype: 'REPLACE', ttl: 300, records: rec('v=spf1 -all') },
      { name: 'old.a.test', type: 'A', changetype: 'REPLACE', ttl: 300, records: [{ content: '9.9.9.9', disabled: true }] },
    ])
    const text = exportZoneFile('a.test', svc.getRRsets('a.test'))
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('$ORIGIN a.test.')
    expect(lines[1]).toMatch(/^a\.test\.\t3600\tIN\tSOA\tns\.a\.test\. hostmaster\.a\.test\. \d{10} 10800/)
    expect(lines[2]).toBe('a.test.\t3600\tIN\tNS\tns.a.test.')
    expect(text).toContain('a.test.\t300\tIN\tMX\t10 mail.a.test.')
    expect(text).toContain('a.test.\t300\tIN\tTXT\t"v=spf1 -all"')
    expect(text).toContain('www.a.test.\t300\tIN\tCNAME\ta.test.')
    expect(text).toContain('; old.a.test.\t300\tIN\tA\t9.9.9.9')
  })
})

describe('SOA edits and counts', () => {
  it('still bumps the serial when an SOA edit keeps the same serial, but honours a different one', () => {
    const { svc, index } = setup()
    const soa = svc.getRRsets('a.test').find((s) => s.type === 'SOA')!.records[0]!.content.split(' ')
    const before = index.get('a.test')!.serial
    soa[3] = '7200'
    svc.setRRset('a.test', 'a.test', 'SOA', 3600, rec(soa.join(' ')))
    expect(index.get('a.test')!.serial).toBe(before + 1)
    soa[2] = '4000000000'
    svc.setRRset('a.test', 'a.test', 'SOA', 3600, rec(soa.join(' ')))
    expect(index.get('a.test')!.serial).toBe(4000000000)
  })

  it('reports record counts without the SOA', () => {
    const { svc } = setup()
    svc.setRRset('a.test', 'x.a.test', 'A', 60, rec('1.1.1.1', '2.2.2.2'))
    expect(svc.listZones()[0]!.recordCount).toBe(3) // NS + two A
  })
})
