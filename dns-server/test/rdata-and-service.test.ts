import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.js'
import { ValidationError } from '../src/dns/names.js'
import { encodeRdata } from '../src/dns/rdata.js'
import { nextSerial } from '../src/zones/serial.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ConflictError, NotFoundError, ZoneService } from '../src/zones/zone-service.js'

describe('rdata validation', () => {
  it('encodes IPv4/IPv6', () => {
    expect([...encodeRdata('A', '10.0.0.1').wire]).toEqual([10, 0, 0, 1])
    expect(encodeRdata('AAAA', '::1').wire.equals(Buffer.from('00000000000000000000000000000001', 'hex'))).toBe(true)
    expect(encodeRdata('AAAA', '2001:db8::ff00:42:8329').wire.toString('hex')).toBe('20010db8000000000000ff0000428329')
    expect(encodeRdata('AAAA', '::ffff:1.2.3.4').wire.toString('hex')).toBe('00000000000000000000ffff01020304')
  })

  it.each([
    ['A', '300.1.1.1'],
    ['A', 'example.com'],
    ['AAAA', '1.2.3.4'],
    ['MX', 'mail.example.com'],
    ['MX', '99999 mail.example.com'],
    ['SRV', '1 2 3'],
    ['CAA', 'issue letsencrypt.org'],
    ['SOA', 'a b c'],
    ['CNAME', 'bad host'],
    ['TXT', '"unterminated'],
  ] as const)('rejects invalid %s content %s', (type, content) => {
    expect(() => encodeRdata(type, content)).toThrow(ValidationError)
  })

  it('splits long TXT into 255-byte strings', () => {
    const wire = encodeRdata('TXT', 'x'.repeat(600)).wire
    expect(wire[0]).toBe(255)
    expect(wire[256]).toBe(255)
    expect(wire.length).toBe(600 + 3)
  })

  it('records MX/NS/SRV targets', () => {
    expect(encodeRdata('MX', '10 Mail.Example.com.').target).toBe('mail.example.com')
    expect(encodeRdata('A', '1.1.1.1').target).toBeUndefined()
  })
})

describe('serial', () => {
  const d = new Date(Date.UTC(2026, 9, 14))
  it('starts at YYYYMMDD00 and increments within the day', () => {
    expect(nextSerial(0, d)).toBe(2026101400)
    expect(nextSerial(2026101400, d)).toBe(2026101401)
    expect(nextSerial(2026101450, d)).toBe(2026101451)
  })
  it('moves forward to a new day', () => {
    expect(nextSerial(2026101399, d)).toBe(2026101400)
  })
})

function setup() {
  const db = openDatabase(':memory:')
  const index = new ZoneIndex()
  const svc = new ZoneService(new ZoneRepository(db), index)
  return { db, index, svc }
}
const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))

describe('ZoneService', () => {
  it('creates a zone with SOA + NS and serves it', () => {
    const { svc, index } = setup()
    svc.createZone({ name: 'Example.com.', nameservers: ['ns1.example.com'] })
    expect(index.findZone('www.example.com')?.apex).toBe('example.com')
    expect(svc.getRRsets('example.com').map((s) => s.type)).toEqual(['NS', 'SOA'])
  })

  it('rejects duplicate zones and zones without nameservers', () => {
    const { svc } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    expect(() => svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })).toThrow(ConflictError)
    expect(() => svc.createZone({ name: 'b.test', nameservers: [] })).toThrow(ValidationError)
  })

  it('bumps the serial on every change, once per write', () => {
    const { svc, index } = setup()
    const now = new Date(Date.UTC(2026, 9, 14))
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] }, { actor: 'test', now })
    const serial = () => Number(svc.getRRsets('a.test').find((s) => s.type === 'SOA')!.records[0]!.content.split(' ')[2])
    expect(serial()).toBe(2026101400)
    svc.setRRset('a.test', 'a.test', 'A', 300, rec('1.2.3.4'), { actor: 'test', now })
    expect(serial()).toBe(2026101401)
    svc.deleteRRset('a.test', 'a.test', 'A', { actor: 'test', now })
    expect(serial()).toBe(2026101402)
    expect(index.get('a.test')!.rrsets('a.test')!.get(1)).toBeUndefined()
  })

  it('enforces CNAME exclusivity both ways', () => {
    const { svc } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    svc.setRRset('a.test', 'www.a.test', 'A', 300, rec('1.2.3.4'))
    expect(() => svc.setRRset('a.test', 'www.a.test', 'CNAME', 300, rec('a.test'))).toThrow(/CNAME/)
    svc.setRRset('a.test', 'alias.a.test', 'CNAME', 300, rec('a.test'))
    expect(() => svc.setRRset('a.test', 'alias.a.test', 'TXT', 300, rec('"x"'))).toThrow(/CNAME/)
    expect(() => svc.setRRset('a.test', 'a.test', 'CNAME', 300, rec('x.test'))).toThrow(ValidationError)
  })

  it('rejects records outside the zone and invalid content without changing anything', () => {
    const { svc } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    const before = JSON.stringify(svc.getRRsets('a.test'))
    expect(() => svc.setRRset('a.test', 'x.other.test', 'A', 300, rec('1.2.3.4'))).toThrow(/outside zone/)
    expect(() => svc.setRRset('a.test', 'x.a.test', 'A', 300, rec('nope'))).toThrow(ValidationError)
    expect(() => svc.setRRset('a.test', 'x.a.test', 'A', -1, rec('1.2.3.4'))).toThrow(ValidationError)
    expect(JSON.stringify(svc.getRRsets('a.test'))).toBe(before)
  })

  it('excludes disabled records from answers', () => {
    const { svc, index } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    svc.setRRset('a.test', 'x.a.test', 'A', 300, [
      { content: '1.1.1.1', disabled: false },
      { content: '2.2.2.2', disabled: true },
    ])
    expect(index.get('a.test')!.rrsets('x.a.test')!.get(1)!.rdatas).toHaveLength(1)
  })

  it('protects apex SOA/NS and reports missing things', () => {
    const { svc } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    expect(() => svc.deleteRRset('a.test', 'a.test', 'SOA')).toThrow(ValidationError)
    expect(() => svc.deleteRRset('a.test', 'a.test', 'NS')).toThrow(ValidationError)
    expect(() => svc.deleteRRset('a.test', 'none.a.test', 'A')).toThrow(NotFoundError)
    expect(() => svc.getRRsets('missing.test')).toThrow(NotFoundError)
  })

  it('deleteZone removes it from the index and the db; loadAll restores from the db', () => {
    const { svc, index, db } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    svc.createZone({ name: 'b.test', nameservers: ['ns.b.test'] })
    svc.deleteZone('a.test')
    expect(index.get('a.test')).toBeUndefined()
    const fresh = new ZoneIndex()
    expect(new ZoneService(new ZoneRepository(db), fresh).loadAll()).toEqual({ loaded: 1, failed: [] })
    expect(fresh.get('b.test')).toBeDefined()
  })

  it('picks the most specific zone for nested zones', () => {
    const { svc, index } = setup()
    svc.createZone({ name: 'a.test', nameservers: ['ns.a.test'] })
    svc.createZone({ name: 'sub.a.test', nameservers: ['ns.a.test'] })
    expect(index.findZone('x.sub.a.test')?.apex).toBe('sub.a.test')
    expect(index.findZone('x.a.test')?.apex).toBe('a.test')
    expect(index.findZone('other.test')).toBeUndefined()
  })
})
