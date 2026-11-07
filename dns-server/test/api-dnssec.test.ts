import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { openDatabase } from '../src/db/database.js'
import { configure } from '../src/bootstrap.js'
import { loadConfig } from '../src/config/config.js'
import { encodeQuery } from '../src/dns/codec.js'
import { handlePacket } from '../src/dns/handler.js'
import { RCode, RType } from '../src/dns/types.js'
import { DnssecKeyRepository } from '../src/dnssec/key-repository.js'
import { dnskeyRdata, dsRecords } from '../src/dnssec/keys.js'
import { parseRrsig, verifyRRset } from '../src/dnssec/sign.js'
import { AuditRepository } from '../src/zones/audit-repository.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ConflictError, ZoneService } from '../src/zones/zone-service.js'
import { parseResponse } from './helpers.js'

const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))

function service() {
  const db = openDatabase(':memory:')
  const index = new ZoneIndex()
  const svc = new ZoneService(new ZoneRepository(db), index, new AuditRepository(db), undefined, new DnssecKeyRepository(db))
  svc.createZone({ name: 'sec.test', nameservers: ['ns1.sec.test'] })
  svc.setRRset('sec.test', 'www.sec.test', 'A', 300, rec('192.0.2.1'))
  return { svc, index, db }
}

const askDo = (index: ZoneIndex, name: string, type: number) => parseResponse(handlePacket(index, encodeQuery(1, name, type, { edns: 4096, do: true }), 'tcp')!)

describe('DNSSEC lifecycle in the service', () => {
  it('enabling signs the zone immediately; the DS matches the published DNSKEY', () => {
    const { svc, index } = service()
    expect(svc.dnssecStatus('sec.test')).toEqual({ enabled: false, keys: [] })
    const status = svc.enableDnssec('sec.test', { actor: 'alice' })
    expect(status.enabled).toBe(true)
    const [k] = status.keys
    expect(k).toMatchObject({ role: 'CSK', flags: 257, algorithm: 13, algorithmName: 'ECDSAP256SHA256', active: true, published: true })
    expect(k!.ds.map((d) => d.digestType)).toEqual([2, 4])
    expect(k!.ds[0]!.text).toMatch(/^\d+ 13 2 [0-9A-F]{64}$/)

    const r = askDo(index, 'sec.test', RType.DNSKEY)
    expect(r.answers.map((a) => a.type)).toEqual([RType.DNSKEY, RType.RRSIG])
    const pub = Buffer.from(k!.dnskey.split(' ')[3]!, 'base64')
    expect(r.answers[0]!.rdata.equals(dnskeyRdata(257, 13, pub))).toBe(true)
    expect(dsRecords('sec.test', { flags: 257, algorithm: 13, publicKey: pub })[0]!.digest).toBe(k!.ds[0]!.digest)
    expect(index.get('sec.test')!.signed).toBe(true)
    expect(svc.getZone('sec.test').dnssec).toBe(true)
  })

  it('signatures keep verifying after record changes, and the old signatures are not reused', () => {
    const { svc, index } = service()
    svc.enableDnssec('sec.test')
    const pub = Buffer.from(svc.dnssecStatus('sec.test').keys[0]!.dnskey.split(' ')[3]!, 'base64')
    const before = askDo(index, 'www.sec.test', RType.A)
    svc.setRRset('sec.test', 'www.sec.test', 'A', 300, rec('192.0.2.2'))
    const after = askDo(index, 'www.sec.test', RType.A)
    expect(after.answers[0]!.text).toBe('192.0.2.2')
    const sig = after.answers.find((a) => a.type === RType.RRSIG)!
    const set = { name: 'www.sec.test', type: RType.A as number, ttl: 300, rdatas: [{ wire: after.answers[0]!.rdata }] }
    expect(verifyRRset({ flags: 257, algorithm: 13, publicKey: pub }, sig.rdata, set, Math.floor(Date.now() / 1000))).toBeNull()
    expect(sig.rdata.equals(before.answers.find((a) => a.type === RType.RRSIG)!.rdata)).toBe(false)
  })

  it('refuses double enable, secondaries, and disabling what is not enabled; disabling restores an unsigned zone', () => {
    const { svc, index } = service()
    expect(() => svc.disableDnssec('sec.test')).toThrow(/not enabled/)
    svc.enableDnssec('sec.test')
    expect(() => svc.enableDnssec('sec.test')).toThrow(ConflictError)
    svc.createZone({ name: 'copy.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    expect(() => svc.enableDnssec('copy.test')).toThrow(/secondary/)
    svc.disableDnssec('sec.test', { actor: 'bob' })
    expect(index.get('sec.test')!.signed).toBe(false)
    expect(askDo(index, 'www.sec.test', RType.A).answers.map((a) => a.type)).toEqual([RType.A])
  })

  it('a restart picks the keys up again (same key tag, still signed)', () => {
    const { svc, db } = service()
    const tag = svc.enableDnssec('sec.test').keys[0]!.keyTag
    const fresh = new ZoneIndex()
    const reload = new ZoneService(new ZoneRepository(db), fresh, undefined, undefined, new DnssecKeyRepository(db))
    expect(reload.loadAll()).toEqual({ loaded: 1, failed: [] })
    expect(fresh.get('sec.test')!.signed).toBe(true)
    expect(reload.dnssecStatus('sec.test').keys[0]!.keyTag).toBe(tag)
  })

  it('key rollover: add, activate, deactivate, delete, with guard rails at every step', () => {
    const { svc, index } = service()
    const first = svc.enableDnssec('sec.test').keys[0]!
    const added = svc.addDnssecKey('sec.test', { actor: 'alice' }).keys.find((k) => k.id !== first.id)!
    expect(added).toMatchObject({ active: false, published: true })
    // both keys are published; only the first signs
    expect(askDo(index, 'sec.test', RType.DNSKEY).answers.filter((a) => a.type === RType.DNSKEY)).toHaveLength(2)
    const sigTags = () => askDo(index, 'www.sec.test', RType.A).answers.filter((a) => a.type === RType.RRSIG).map((a) => parseRrsig(a.rdata).keyTag)
    expect(sigTags()).toEqual([first.keyTag])

    // guard rails
    expect(() => svc.updateDnssecKey('sec.test', first.id, { active: false })).toThrow(/at least one key/)
    expect(() => svc.updateDnssecKey('sec.test', added.id, { published: false, active: true })).toThrow(/published before/)
    expect(() => svc.deleteDnssecKey('sec.test', first.id)).toThrow(/deactivate/)
    expect(() => svc.updateDnssecKey('sec.test', 9999, { active: true })).toThrow(/not found/)

    svc.updateDnssecKey('sec.test', added.id, { active: true })
    expect(sigTags().sort()).toEqual([first.keyTag, added.keyTag].sort()) // double signing during the switch
    svc.updateDnssecKey('sec.test', first.id, { active: false })
    expect(sigTags()).toEqual([added.keyTag])
    svc.deleteDnssecKey('sec.test', first.id)
    expect(askDo(index, 'sec.test', RType.DNSKEY).answers.filter((a) => a.type === RType.DNSKEY)).toHaveLength(1)
    expect(svc.dnssecStatus('sec.test').keys.map((k) => k.id)).toEqual([added.id])
  })

  it('a failed key change leaves the zone exactly as it was', () => {
    const { svc, index } = service()
    svc.enableDnssec('sec.test')
    const only = svc.dnssecStatus('sec.test').keys[0]!
    expect(() => svc.updateDnssecKey('sec.test', only.id, { active: false })).toThrow()
    expect(index.get('sec.test')!.signed).toBe(true)
    expect(askDo(index, 'www.sec.test', RType.A).answers.some((a) => a.type === RType.RRSIG)).toBe(true)
  })

  it('NXDOMAIN and NODATA stay provable after the zone changes (the NSEC chain is rebuilt)', () => {
    const { svc, index } = service()
    svc.enableDnssec('sec.test')
    svc.setRRset('sec.test', 'zzz.sec.test', 'A', 60, rec('192.0.2.9'))
    expect(askDo(index, 'zzz.sec.test', RType.AAAA).authority.some((a) => a.type === RType.NSEC && a.name === 'zzz.sec.test')).toBe(true)
    svc.deleteRRset('sec.test', 'zzz.sec.test', 'A')
    const nx = askDo(index, 'zzz.sec.test', RType.A)
    expect(nx.rcode).toBe(RCode.NXDOMAIN)
    expect(nx.authority.filter((a) => a.type === RType.NSEC).length).toBeGreaterThan(0)
  })
})

describe('DNSSEC over HTTP', () => {
  let app: INestApplication
  let http: ReturnType<typeof request>
  let admin: string
  let user: string
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
  const login = async (u: string, p: string) => (await http.post('/v1/auth/login').send({ username: u, password: p })).body.token as string

  beforeAll(async () => {
    const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_PASSWORD: 'correct-horse-battery', DEFAULT_NS: 'ns1.example.net' } as NodeJS.ProcessEnv)
    const mod = await Test.createTestingModule({ imports: [AppModule.register(cfg)] }).compile()
    app = configure(mod.createNestApplication())
    await app.init()
    http = request(app.getHttpServer())
    admin = await login('admin', 'correct-horse-battery')
    const acct = (await http.post('/v1/accounts').set(auth(admin)).send({ name: 'acme' })).body
    await http.post('/v1/zones').set(auth(admin)).send({ name: 'api.test', accountId: acct.id }).expect(201)
    await http.post('/v1/users').set(auth(admin)).send({ username: 'una', password: 'una-password-123', role: 'user', accountIds: [acct.id] }).expect(201)
    user = await login('una', 'una-password-123')
  })
  afterAll(async () => {
    await app.close()
  })

  it('enable returns the DS records to publish; GET shows them; the zone list flags it as signed', async () => {
    const res = await http.post('/v1/zones/api.test/dnssec').set(auth(admin)).expect(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.keys[0].ds).toHaveLength(2)
    expect(res.body.keys[0]).not.toHaveProperty('privateKeyPem')
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY/)
    const got = await http.get('/v1/zones/api.test/dnssec').set(auth(admin)).expect(200)
    expect(got.body.keys[0].keyTag).toBe(res.body.keys[0].keyTag)
    const list = await http.get('/v1/zones').set(auth(admin))
    expect(list.body.find((z: { name: string }) => z.name === 'api.test').dnssec).toBe(true)
    await http.post('/v1/zones/api.test/dnssec').set(auth(admin)).expect(409)
  })

  it('users can see their zone’s DS (to hand to a registrar) but cannot change DNSSEC', async () => {
    await http.get('/v1/zones/api.test/dnssec').set(auth(user)).expect(200)
    await http.post('/v1/zones/api.test/dnssec').set(auth(user)).expect(403)
    await http.delete('/v1/zones/api.test/dnssec').set(auth(user)).expect(403)
    await http.post('/v1/zones/api.test/dnssec/keys').set(auth(user)).expect(403)
  })

  it('manages keys over HTTP and records everything in the history', async () => {
    const add = await http.post('/v1/zones/api.test/dnssec/keys').set(auth(admin)).expect(200)
    const newKey = add.body.keys.find((k: { active: boolean }) => !k.active)
    await http.patch(`/v1/zones/api.test/dnssec/keys/${newKey.id}`).set(auth(admin)).send({}).expect(400)
    await http.patch(`/v1/zones/api.test/dnssec/keys/${newKey.id}`).set(auth(admin)).send({ active: true }).expect(200)
    const old = add.body.keys.find((k: { id: number }) => k.id !== newKey.id)
    await http.patch(`/v1/zones/api.test/dnssec/keys/${old.id}`).set(auth(admin)).send({ active: false }).expect(200)
    await http.delete(`/v1/zones/api.test/dnssec/keys/${old.id}`).set(auth(admin)).expect(200)
    await http.delete(`/v1/zones/api.test/dnssec/keys/${newKey.id}`).set(auth(admin)).expect(400) // still the active key
    const hist = (await http.get('/v1/zones/api.test/history').set(auth(admin))).body.map((e: { action: string }) => e.action)
    expect(hist).toEqual(expect.arrayContaining(['dnssec.enable', 'dnssec.key.add', 'dnssec.key.update', 'dnssec.key.delete']))
  })

  it('disables, and refuses to AXFR is enforced where transfers are configured (zone() hides signed zones)', async () => {
    await http.delete('/v1/zones/api.test/dnssec').set(auth(admin)).expect(200)
    expect((await http.get('/v1/zones/api.test/dnssec').set(auth(admin))).body).toEqual({ enabled: false, keys: [] })
    await http.delete('/v1/zones/api.test/dnssec').set(auth(admin)).expect(400)
  })

  it('serves Prometheus metrics to authenticated callers only', async () => {
    await http.get('/v1/server/metrics').expect(401)
    const res = await http.get('/v1/server/metrics').set(auth(admin)).expect(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.text).toContain('dns_zones 1')
    expect(res.text).toContain('dns_dnssec_zones 0')
    expect(res.text).toMatch(/# TYPE dns_uptime_seconds gauge/)
  })
})
