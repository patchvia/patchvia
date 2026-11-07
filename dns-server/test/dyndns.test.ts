import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { configure } from '../src/bootstrap.js'
import { loadConfig } from '../src/config/config.js'
import { openDatabase } from '../src/db/database.js'
import { RType } from '../src/dns/types.js'
import { parsePublishableIp } from '../src/dyndns/ip.js'
import { DynDnsRepository } from '../src/dyndns/dyndns.repository.js'
import { DynDnsService } from '../src/dyndns/dyndns.service.js'
import { AuditRepository } from '../src/zones/audit-repository.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ZoneService } from '../src/zones/zone-service.js'
import { ask } from './helpers.js'

describe('publishable addresses', () => {
  it.each([
    ['203.0.113.5', 4],
    ['192.168.1.20', 4],
    ['10.0.0.1', 4],
    ['2001:db8::5', 6],
    ['::ffff:203.0.113.9', 4],
  ])('accepts %s', (input, family) => {
    expect(parsePublishableIp(input)).toMatchObject({ family })
  })
  it.each(['', undefined, 'nope', '0.0.0.0', '127.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'ff02::1', '999.1.1.1'])('rejects %j', (input) => {
    expect(parsePublishableIp(input)).toHaveProperty('error')
  })
})

describe('DynDnsService', () => {
  function setup(now = () => 1_000_000) {
    const db = openDatabase(':memory:')
    const index = new ZoneIndex()
    const zones = new ZoneService(new ZoneRepository(db), index, new AuditRepository(db))
    zones.createZone({ name: 'd.test', nameservers: ['ns.d.test'] })
    return { zones, index, dyn: new DynDnsService(new DynDnsRepository(db), zones, now), db }
  }

  it('a no-change update writes nothing: serial, history and NOTIFY stay quiet', () => {
    const { zones, dyn } = setup()
    const { token } = dyn.create('d.test', { name: 'home.d.test' })
    expect(dyn.update(token, ['203.0.113.5'], '1.1.1.1')).toMatchObject({ status: 'good', ip4: '203.0.113.5' })
    const serial = zones.getZone('d.test').serial
    const history = zones.getRRsets('d.test').length
    for (let i = 0; i < 20; i++) expect(dyn.update(token, ['203.0.113.5'], '1.1.1.1')).toMatchObject({ status: 'nochg' })
    expect(zones.getZone('d.test').serial).toBe(serial)
    expect(zones.getRRsets('d.test')).toHaveLength(history)
  })

  it('sets A and AAAA from one call, replacing only that name', () => {
    const { zones, dyn, index } = setup()
    zones.setRRset('d.test', 'other.d.test', 'A', 300, [{ content: '192.0.2.1', disabled: false }])
    const { token } = dyn.create('d.test', { name: 'home.d.test', ttl: 30 })
    expect(dyn.update(token, ['203.0.113.5', '2001:db8::5'], 'x')).toMatchObject({ status: 'good', ip4: '203.0.113.5', ip6: '2001:db8::5' })
    expect(ask(index, 'home.d.test', RType.A).answers[0]).toMatchObject({ text: '203.0.113.5', ttl: 30 })
    expect(ask(index, 'home.d.test', RType.AAAA).answers[0]!.text).toBe('2001:db8:0:0:0:0:0:5')
    expect(ask(index, 'other.d.test', RType.A).answers[0]!.text).toBe('192.0.2.1') // untouched
    expect(dyn.update(token, ['203.0.113.6'], 'x')).toMatchObject({ status: 'good' })
    expect(ask(index, 'home.d.test', RType.AAAA).answers).toHaveLength(1) // v6 not touched when only v4 given
  })

  it('skips an unusable address when another one is usable, but reports a lone bad one', () => {
    const { dyn } = setup()
    const { token } = dyn.create('d.test', { name: 'home.d.test' })
    expect(dyn.update(token, ['127.0.0.1', '203.0.113.5'], 'x')).toMatchObject({ status: 'good', ip4: '203.0.113.5' })
    expect(dyn.update(token, ['127.0.0.1'], 'x')).toMatchObject({ status: 'badip' })
    expect(dyn.update(token, [undefined], 'x')).toMatchObject({ status: 'badip' })
  })

  it('a token can only change its own name', () => {
    const { dyn } = setup()
    const { token } = dyn.create('d.test', { name: 'home.d.test' })
    expect(dyn.update(token, ['203.0.113.5'], 'x', 'other.d.test')).toMatchObject({ status: 'nohost' })
    expect(dyn.update(token, ['203.0.113.5'], 'x', 'HOME.d.test.')).toMatchObject({ status: 'good' })
  })

  it('validates creation: inside the zone, no duplicates, no CNAME clash, sane TTL, no secondaries', () => {
    const { zones, dyn } = setup()
    expect(() => dyn.create('d.test', { name: 'x.other.test' })).toThrow(/outside/)
    expect(() => dyn.create('d.test', { name: 'a.d.test', ttl: 0 })).toThrow(/TTL/)
    dyn.create('d.test', { name: 'a.d.test' })
    expect(() => dyn.create('d.test', { name: 'a.d.test' })).toThrow(/already has/)
    zones.setRRset('d.test', 'alias.d.test', 'CNAME', 60, [{ content: 'a.d.test', disabled: false }])
    expect(() => dyn.create('d.test', { name: 'alias.d.test' })).toThrow(/CNAME/)
    zones.createZone({ name: 'copy.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    expect(() => dyn.create('copy.test', { name: 'x.copy.test' })).toThrow(/secondary/)
  })

  it('stops an updater that flaps: 6 changes a minute, then abuse; refills after a minute', () => {
    let t = 1_000_000
    const { dyn } = setup(() => t)
    const { token } = dyn.create('d.test', { name: 'home.d.test' })
    const results = Array.from({ length: 8 }, (_, i) => dyn.update(token, [`203.0.113.${i + 1}`], 'x').status)
    expect(results).toEqual(['good', 'good', 'good', 'good', 'good', 'good', 'abuse', 'abuse'])
    expect(dyn.update(token, ['203.0.113.6'], 'x').status).toBe('nochg') // reads never count
    t += 61_000
    expect(dyn.update(token, ['203.0.113.100'], 'x').status).toBe('good')
  })

  it('throttles an address that keeps guessing tokens', () => {
    let t = 1_000_000
    const { dyn } = setup(() => t)
    for (let i = 0; i < 10; i++) expect(dyn.update(`ddns_wrong${i}`, ['203.0.113.5'], '9.9.9.9').status).toBe('badauth')
    expect(dyn.update('ddns_wrong', ['203.0.113.5'], '9.9.9.9').status).toBe('abuse')
    expect(dyn.update('ddns_wrong', ['203.0.113.5'], '8.8.8.8').status).toBe('badauth') // other addresses unaffected
    t += 61_000
    expect(dyn.update('ddns_wrong', ['203.0.113.5'], '9.9.9.9').status).toBe('badauth')
  })

  it('only the hash is stored, and deleting the token revokes it', () => {
    const { dyn, db } = setup()
    const { token, id } = dyn.create('d.test', { name: 'home.d.test' })
    const raw = JSON.stringify(db.prepare('SELECT * FROM dyndns_tokens').all())
    expect(raw).not.toContain(token)
    expect(raw).toContain(token.slice(0, 10))
    dyn.delete('d.test', id)
    expect(dyn.update(token, ['203.0.113.5'], 'x').status).toBe('badauth')
  })
})

describe('dynamic DNS over HTTP', () => {
  let app: INestApplication
  let http: ReturnType<typeof request>
  let admin: string
  let outsider: string
  let token: string
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
  const login = async (u: string, p: string) => (await http.post('/v1/auth/login').send({ username: u, password: p })).body.token as string

  beforeAll(async () => {
    const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_PASSWORD: 'correct-horse-battery', DEFAULT_NS: 'ns1.example.net' } as NodeJS.ProcessEnv)
    const mod = await Test.createTestingModule({ imports: [AppModule.register(cfg)] }).compile()
    app = configure(mod.createNestApplication())
    await app.init()
    http = request(app.getHttpServer())
    admin = await login('admin', 'correct-horse-battery')
    const mine = (await http.post('/v1/accounts').set(auth(admin)).send({ name: 'mine' })).body
    const other = (await http.post('/v1/accounts').set(auth(admin)).send({ name: 'other' })).body
    await http.post('/v1/zones').set(auth(admin)).send({ name: 'h.test', accountId: mine.id }).expect(201)
    await http.post('/v1/users').set(auth(admin)).send({ username: 'olga', password: 'olga-password-1', role: 'user', accountIds: [other.id] }).expect(201)
    outsider = await login('olga', 'olga-password-1')
  })
  afterAll(async () => {
    await app.close()
  })

  it('creates a token that is shown once, with sensible defaults', async () => {
    const res = await http.post('/v1/zones/h.test/dyndns').set(auth(admin)).send({ name: 'home.h.test' }).expect(201)
    expect(res.body).toMatchObject({ name: 'home.h.test', ttl: 60 })
    expect(res.body.token).toMatch(/^ddns_/)
    token = res.body.token
    const list = await http.get('/v1/zones/h.test/dyndns').set(auth(admin)).expect(200)
    expect(JSON.stringify(list.body)).not.toContain(token)
    expect(list.body[0]).toMatchObject({ name: 'home.h.test', lastUsedAt: null })
    await http.post('/v1/zones/h.test/dyndns').set(auth(admin)).send({ name: 'home.h.test' }).expect(409)
  })

  it('keeps tokens of other accounts’ zones out of reach', async () => {
    await http.get('/v1/zones/h.test/dyndns').set(auth(outsider)).expect(404)
    await http.post('/v1/zones/h.test/dyndns').set(auth(outsider)).send({ name: 'evil.h.test' }).expect(404)
  })

  it('/dyn/update needs no login, takes the token as a query parameter or bearer, and publishes the address', async () => {
    const a = await http.get('/dyn/update').query({ token, ip: '203.0.113.10' }).expect(200)
    expect(a.body).toMatchObject({ status: 'good', name: 'home.h.test', ip4: '203.0.113.10' })
    expect(ask(app.get(ZoneIndex), 'home.h.test', RType.A).answers[0]!.text).toBe('203.0.113.10')
    await http.get('/dyn/update').query({ token, ip: '203.0.113.10' }).expect(200, { status: 'nochg', name: 'home.h.test', ip4: '203.0.113.10' })
    await http.post('/dyn/update').set('Authorization', `Bearer ${token}`).query({ ip: '203.0.113.11', ip6: '2001:db8::11' }).expect(200)
    expect(ask(app.get(ZoneIndex), 'home.h.test', RType.AAAA).answers).toHaveLength(1)
  })

  it('reports problems with the right status codes', async () => {
    await http.get('/dyn/update').query({ token: 'ddns_nope', ip: '203.0.113.10' }).expect(401)
    await http.get('/dyn/update').expect(401)
    await http.get('/dyn/update').query({ token, ip: 'banana' }).expect(400)
    await http.get('/dyn/update').query({ token }).expect(400) // the test client is 127.0.0.1, which is not publishable
  })

  it('token creation is in the history, attributed to who created it', async () => {
    const hist = (await http.get('/v1/zones/h.test/history').set(auth(admin))).body
    expect(hist.find((e: { action: string }) => e.action === 'dyndns.create')).toMatchObject({ actor: 'admin', detail: { name: 'home.h.test', ttl: 60 } })
  })

  it('the history shows which token made each change', async () => {
    const hist = (await http.get('/v1/zones/h.test/history').set(auth(admin))).body
    expect(hist.find((e: { action: string }) => e.action === 'rrset.replace').actor).toBe('dyndns:home.h.test')
  })

  it('/nic/update speaks DynDNS2: basic auth with the token as password, plain-text replies', async () => {
    const basic = (pw: string) => ({ Authorization: 'Basic ' + Buffer.from(`ddns:${pw}`).toString('base64') })
    const ok = await http.get('/nic/update').set(basic(token)).query({ hostname: 'home.h.test', myip: '203.0.113.20' }).expect(200)
    expect(ok.text).toBe('good 203.0.113.20')
    expect(ok.headers['content-type']).toMatch(/text\/plain/)
    expect((await http.get('/nic/update').set(basic(token)).query({ hostname: 'home.h.test', myip: '203.0.113.20' })).text).toBe('nochg 203.0.113.20')
    expect((await http.get('/nic/update').set(basic(token)).query({ hostname: 'other.h.test', myip: '203.0.113.20' })).text).toBe('nohost')
    expect((await http.get('/nic/update').set(basic(token)).query({ myip: '203.0.113.20' })).text).toBe('notfqdn')
    const bad = await http.get('/nic/update').set(basic('ddns_wrong')).query({ hostname: 'home.h.test', myip: '203.0.113.20' }).expect(401)
    expect(bad.text).toBe('badauth')
    expect((await http.get('/nic/update').set(basic(token)).query({ hostname: 'home.h.test', myip: 'nonsense' })).text).toBe('dnserr')
  })

  it('records the last address and use time, supports TTL changes, and revokes on delete', async () => {
    const list = (await http.get('/v1/zones/h.test/dyndns').set(auth(admin))).body
    expect(list[0]).toMatchObject({ lastIp4: '203.0.113.20' })
    expect(list[0].lastUsedAt).toBeTruthy()
    await http.patch(`/v1/zones/h.test/dyndns/${list[0].id}`).set(auth(admin)).send({ ttl: 120 }).expect(200)
    await http.patch(`/v1/zones/h.test/dyndns/${list[0].id}`).set(auth(admin)).send({ ttl: 0 }).expect(400)
    await http.delete(`/v1/zones/h.test/dyndns/${list[0].id}`).set(auth(admin)).expect(204)
    expect((await http.get('/v1/zones/h.test/history').set(auth(admin))).body[0]).toMatchObject({ action: 'dyndns.delete', actor: 'admin' })
    await http.get('/dyn/update').query({ token, ip: '203.0.113.30' }).expect(401)
    await http.delete(`/v1/zones/h.test/dyndns/${list[0].id}`).set(auth(admin)).expect(404)
  })
})
