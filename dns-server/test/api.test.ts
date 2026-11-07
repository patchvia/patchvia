import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { configure } from '../src/bootstrap.js'
import { loadConfig } from '../src/config/config.js'
import { RType } from '../src/dns/types.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ask } from './helpers.js'

const ADMIN_PW = 'correct-horse-battery'
let app: INestApplication
let http: ReturnType<typeof request>
let adminToken: string

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const login = async (username: string, password: string) => (await http.post('/v1/auth/login').send({ username, password })).body.token as string

beforeAll(async () => {
  const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_PASSWORD: ADMIN_PW, DEFAULT_NS: 'ns1.example.net' } as NodeJS.ProcessEnv)
  const mod = await Test.createTestingModule({ imports: [AppModule.register(cfg)] }).compile()
  app = configure(mod.createNestApplication())
  await app.init()
  http = request(app.getHttpServer())
  adminToken = await login('admin', ADMIN_PW)
})
afterAll(async () => {
  await app.close()
})

describe('authentication', () => {
  it('health is public, everything else needs credentials', async () => {
    await http.get('/v1/server/health').expect(200, { status: 'ok' })
    await http.get('/v1/zones').expect(401)
    await http.get('/v1/zones').set('Authorization', 'Bearer garbage').expect(401)
  })

  it('logs in, returns the user and no password hash', async () => {
    const res = await http.post('/v1/auth/login').send({ username: 'Admin', password: ADMIN_PW }).expect(200)
    expect(res.body.user).toMatchObject({ username: 'admin', role: 'admin' })
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|password/i)
    const me = await http.get('/v1/auth/me').set(auth(res.body.token)).expect(200)
    expect(me.body).toMatchObject({ username: 'admin', via: 'session', scope: 'full' })
  })

  it('rejects bad passwords identically for unknown users, then rate limits', async () => {
    const a = await http.post('/v1/auth/login').send({ username: 'admin', password: 'wrong-wrong-1' })
    const b = await http.post('/v1/auth/login').send({ username: 'ghost', password: 'wrong-wrong-1' })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body.message).toBe(b.body.message)
    for (let i = 0; i < 5; i++) await http.post('/v1/auth/login').send({ username: 'victim', password: 'x' })
    await http.post('/v1/auth/login').send({ username: 'victim', password: 'x' }).expect(429)
  })

  it('changing the password invalidates old tokens', async () => {
    await http.post('/v1/users').set(auth(adminToken)).send({ username: 'carol', password: 'carol-password-1', role: 'operator' }).expect(201)
    const old = await login('carol', 'carol-password-1')
    await http.post('/v1/auth/change-password').set(auth(old)).send({ currentPassword: 'nope-nope-nope', newPassword: 'carol-password-2' }).expect(403)
    const res = await http.post('/v1/auth/change-password').set(auth(old)).send({ currentPassword: 'carol-password-1', newPassword: 'carol-password-2' }).expect(200)
    await http.get('/v1/auth/me').set(auth(old)).expect(401)
    await http.get('/v1/auth/me').set(auth(res.body.token)).expect(200)
  })
})

describe('zones', () => {
  it('creates a zone using default nameservers, serves it over DNS immediately', async () => {
    const res = await http.post('/v1/zones').set(auth(adminToken)).send({ name: 'Shop.Example.' }).expect(201)
    expect(res.body.name).toBe('shop.example')
    expect(res.body.rrsets.map((r: { type: string }) => r.type)).toEqual(['NS', 'SOA'])
    expect(res.body.rrsets[0].records[0].content).toBe('ns1.example.net')
    const idx = app.get(ZoneIndex)
    expect(ask(idx, 'shop.example', RType.NS).answers.map((a) => a.text)).toEqual(['ns1.example.net'])
  })

  it('patches RRsets, supports "@", and the change is live in DNS with a bumped serial', async () => {
    const before = (await http.get('/v1/zones/shop.example').set(auth(adminToken))).body.serial
    const res = await http
      .patch('/v1/zones/shop.example/rrsets')
      .set(auth(adminToken))
      .send({
        rrsets: [
          { name: '@', type: 'A', ttl: 300, records: [{ content: '192.0.2.1' }] },
          { name: 'www.shop.example', type: 'CNAME', ttl: 300, records: [{ content: 'shop.example' }] },
          { name: '@', type: 'MX', ttl: 300, records: [{ content: '10 mail.shop.example' }] },
        ],
      })
      .expect(200)
    expect(res.body.serial).toBe(before + 1)
    expect(ask(app.get(ZoneIndex), 'www.shop.example', RType.A).answers.map((a) => a.text)).toEqual(['shop.example', '192.0.2.1'])
  })

  it('rejects an invalid batch atomically with a helpful message', async () => {
    const before = (await http.get('/v1/zones/shop.example').set(auth(adminToken))).body
    const res = await http
      .patch('/v1/zones/shop.example/rrsets')
      .set(auth(adminToken))
      .send({
        rrsets: [
          { name: 'good.shop.example', type: 'A', ttl: 60, records: [{ content: '192.0.2.9' }] },
          { name: 'bad.shop.example', type: 'A', ttl: 60, records: [{ content: '999.1.1.1' }] },
        ],
      })
      .expect(400)
    expect(res.body.message).toMatch(/invalid IPv4/)
    const after = (await http.get('/v1/zones/shop.example').set(auth(adminToken))).body
    expect(after).toEqual(before)
  })

  it('validates input shapes and unknown zones', async () => {
    await http.post('/v1/zones').set(auth(adminToken)).send({ name: '' }).expect(400)
    await http.post('/v1/zones').set(auth(adminToken)).send({ name: 'shop.example' }).expect(409)
    await http.patch('/v1/zones/shop.example/rrsets').set(auth(adminToken)).send({ rrsets: [{ name: 'x.shop.example', type: 'A' }] }).expect(400)
    await http.patch('/v1/zones/shop.example/rrsets').set(auth(adminToken)).send({ rrsets: [{ name: 'x.shop.example', type: 'BOGUS', ttl: 1, records: [{ content: 'x' }] }] }).expect(400)
    await http.get('/v1/zones/nope.example').set(auth(adminToken)).expect(404)
  })

  it('exports a zone file and records history with the actor', async () => {
    const file = await http.get('/v1/zones/shop.example/export').set(auth(adminToken)).expect(200)
    expect(file.headers['content-type']).toMatch(/text\/plain/)
    expect(file.text).toContain('www.shop.example.\t300\tIN\tCNAME\tshop.example.')
    const hist = await http.get('/v1/zones/shop.example/history').set(auth(adminToken)).expect(200)
    expect(hist.body[0]).toMatchObject({ actor: 'admin', action: 'rrset.replace' })
    expect(hist.body.at(-1)).toMatchObject({ action: 'zone.create' })
  })

  it('deletes a zone and stops serving it', async () => {
    await http.post('/v1/zones').set(auth(adminToken)).send({ name: 'tmp.example' }).expect(201)
    await http.delete('/v1/zones/tmp.example').set(auth(adminToken)).expect(204)
    expect(ask(app.get(ZoneIndex), 'tmp.example', RType.A).rcode).toBe(5)
  })
})

describe('roles and accounts', () => {
  let userToken: string
  it('scopes plain users to their accounts and hides everything else', async () => {
    const acct = (await http.post('/v1/accounts').set(auth(adminToken)).send({ name: 'acme' })).body
    await http.post('/v1/zones').set(auth(adminToken)).send({ name: 'acme.example', accountId: acct.id }).expect(201)
    await http.post('/v1/zones').set(auth(adminToken)).send({ name: 'secret.example' }).expect(201)
    await http.post('/v1/users').set(auth(adminToken)).send({ username: 'dave', password: 'dave-password-1', role: 'user', accountIds: [acct.id] }).expect(201)
    userToken = await login('dave', 'dave-password-1')

    const list = await http.get('/v1/zones').set(auth(userToken)).expect(200)
    expect(list.body.map((z: { name: string }) => z.name)).toEqual(['acme.example'])
    expect(list.body[0].accountName).toBe('acme')
    await http.get('/v1/zones/secret.example').set(auth(userToken)).expect(404)
    await http.patch('/v1/zones/secret.example/rrsets').set(auth(userToken)).send({ rrsets: [{ name: 'x.secret.example', type: 'A', ttl: 1, records: [{ content: '1.1.1.1' }] }] }).expect(404)
    await http.patch('/v1/zones/acme.example/rrsets').set(auth(userToken)).send({ rrsets: [{ name: 'www.acme.example', type: 'A', ttl: 60, records: [{ content: '1.1.1.1' }] }] }).expect(200)
  })

  it('forbids users from managing zones, accounts and other users', async () => {
    await http.post('/v1/zones').set(auth(userToken)).send({ name: 'new.example' }).expect(403)
    await http.delete('/v1/zones/acme.example').set(auth(userToken)).expect(403)
    await http.patch('/v1/zones/acme.example').set(auth(userToken)).send({ accountId: null }).expect(403)
    await http.get('/v1/accounts').set(auth(userToken)).expect(403)
    await http.get('/v1/users').set(auth(userToken)).expect(403)
  })

  it('lets operators manage zones but not users', async () => {
    const op = await login('carol', 'carol-password-2')
    await http.get('/v1/zones').set(auth(op)).expect(200)
    await http.post('/v1/zones').set(auth(op)).send({ name: 'ops.example' }).expect(201)
    await http.get('/v1/accounts').set(auth(op)).expect(200)
    await http.post('/v1/accounts').set(auth(op)).send({ name: 'x' }).expect(403)
    await http.get('/v1/users').set(auth(op)).expect(403)
  })

  it('protects the last administrator and the acting user', async () => {
    const me = (await http.get('/v1/auth/me').set(auth(adminToken))).body
    await http.delete(`/v1/users/${me.id}`).set(auth(adminToken)).expect(403)
    await http.patch(`/v1/users/${me.id}`).set(auth(adminToken)).send({ role: 'user' }).expect(403)
  })

  it('removing a user role change invalidates their sessions', async () => {
    const dave = (await http.get('/v1/users').set(auth(adminToken))).body.find((u: { username: string }) => u.username === 'dave')
    await http.patch(`/v1/users/${dave.id}`).set(auth(adminToken)).send({ role: 'operator' }).expect(200)
    await http.get('/v1/zones').set(auth(userToken)).expect(401)
  })
})

describe('API keys', () => {
  let readKey: string
  let writeKey: string
  let writeId: number

  it('creates keys once, never exposes the secret again', async () => {
    const r = await http.post('/v1/api-keys').set(auth(adminToken)).send({ name: 'ci-read' }).expect(201)
    readKey = r.body.key
    expect(readKey).toMatch(/^dnk_/)
    const w = await http.post('/v1/api-keys').set(auth(adminToken)).send({ name: 'ci-write', scope: 'write' }).expect(201)
    writeKey = w.body.key
    writeId = w.body.id
    const list = await http.get('/v1/api-keys').set(auth(adminToken)).expect(200)
    expect(JSON.stringify(list.body)).not.toContain(readKey)
    expect(list.body.map((k: { name: string }) => k.name)).toEqual(['ci-read', 'ci-write'])
  })

  it('authenticates via X-API-Key and Bearer, enforcing scope', async () => {
    await http.get('/v1/zones').set('X-API-Key', readKey).expect(200)
    await http.get('/v1/zones').set('Authorization', `Bearer ${readKey}`).expect(200)
    const body = { rrsets: [{ name: 'k.shop.example', type: 'A', ttl: 60, records: [{ content: '1.1.1.1' }] }] }
    await http.patch('/v1/zones/shop.example/rrsets').set('X-API-Key', readKey).send(body).expect(403)
    await http.patch('/v1/zones/shop.example/rrsets').set('X-API-Key', writeKey).send(body).expect(200)
    const hist = await http.get('/v1/zones/shop.example/history').set(auth(adminToken))
    expect(hist.body[0].actor).toBe('admin') // a key acts as its owner
  })

  it('keys can never manage credentials', async () => {
    await http.post('/v1/api-keys').set('X-API-Key', writeKey).send({ name: 'x' }).expect(403)
    await http.get('/v1/users').set('X-API-Key', writeKey).expect(403)
    await http.post('/v1/auth/change-password').set('X-API-Key', writeKey).send({ currentPassword: 'a', newPassword: 'b' }).expect(403)
  })

  it('revoked keys stop working immediately', async () => {
    await http.delete(`/v1/api-keys/${writeId}`).set(auth(adminToken)).expect(204)
    await http.get('/v1/zones').set('X-API-Key', writeKey).expect(401)
    await http.get('/v1/zones').set('X-API-Key', 'dnk_forged').expect(401)
  })

  it('exposes recent activity to admins/operators only', async () => {
    const res = await http.get('/v1/server/activity?limit=3').set(auth(adminToken)).expect(200)
    expect(res.body).toHaveLength(3)
    expect(res.body[0].id).toBeGreaterThan(res.body[1].id)
    const user = (await http.get('/v1/users').set(auth(adminToken))).body.find((u: { role: string }) => u.role === 'user')
    expect(user).toBeUndefined() // dave was promoted earlier; create a fresh plain user
    await http.post('/v1/users').set(auth(adminToken)).send({ username: 'erin', password: 'erin-password-1', role: 'user' }).expect(201)
    const erin = await login('erin', 'erin-password-1')
    await http.get('/v1/server/activity').set(auth(erin)).expect(403)
  })

  it('reports server stats', async () => {
    const res = await http.get('/v1/server/stats').set(auth(adminToken)).expect(200)
    expect(res.body).toMatchObject({ zones: expect.any(Number), queries: { total: expect.any(Number) } })
  })
})

describe('zone import uses the default nameservers, like creating a zone', () => {
  it('a zone file without NS records gets DEFAULT_NS, in the dry run and the real import', async () => {
    const h = auth(adminToken)
    const file = '$ORIGIN fromdefault.test.\n@ A 192.0.2.1\n'
    const dry = await http.post('/v1/zones/import').set(h).send({ zonefile: file, dryRun: true }).expect(200)
    expect(dry.body.ok).toBe(true)
    await http.post('/v1/zones/import').set(h).send({ zonefile: file }).expect(200)
    const ns = (await http.get('/v1/zones/fromdefault.test').set(h)).body.rrsets.find((r: { type: string }) => r.type === 'NS')
    expect(ns.records.map((r: { content: string }) => r.content)).toEqual(['ns1.example.net'])
  })
})

