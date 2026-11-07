import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { configure } from '../src/bootstrap.js'
import { loadConfig } from '../src/config/config.js'
import { RType } from '../src/dns/types.js'
import type { ReplicationIO, TransferData } from '../src/replication/io.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ask } from './helpers.js'

const PW = 'correct-horse-battery'
let app: INestApplication
let http: ReturnType<typeof request>
let admin: string
let user: string
const sent: { host: string; port: number }[] = []
let failTransfers = false

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const login = async (username: string, password: string) => (await http.post('/v1/auth/login').send({ username, password })).body.token as string

const transfer = (serial: number, zone = 'sec.test'): TransferData => ({
  serial,
  skipped: { DNSKEY: 1 },
  rrsets: [
    { name: zone, type: 'SOA', ttl: 3600, contents: [`ns1.${zone} hostmaster.${zone} ${serial} 600 120 604800 300`] },
    { name: zone, type: 'NS', ttl: 3600, contents: [`ns1.${zone}`] },
    { name: `www.${zone}`, type: 'A', ttl: 300, contents: ['192.0.2.8'] },
  ],
})

const io: ReplicationIO = {
  soaSerial: async () => 2026101599,
  axfr: async (_t, zone) => {
    if (failTransfers) throw new Error('connection refused')
    return transfer(2026101599, zone)
  },
  sendNotify: async (t, packet) => {
    sent.push({ host: t.host, port: t.port })
    if (t.host === '192.0.2.99') return null
    const reply = Buffer.from(packet)
    reply[2] = reply[2]! | 0x80
    return reply
  },
}

beforeAll(async () => {
  const cfg = loadConfig({
    DB_PATH: ':memory:',
    ADMIN_PASSWORD: PW,
    DEFAULT_NS: 'ns1.example.net',
    NOTIFY_TO: '192.0.2.50, 192.0.2.99:5353',
    ALLOW_AXFR_FROM: '203.0.113.0/24',
  } as NodeJS.ProcessEnv)
  const mod = await Test.createTestingModule({ imports: [AppModule.register(cfg, { io })] }).compile()
  app = configure(mod.createNestApplication())
  await app.init()
  http = request(app.getHttpServer())
  admin = await login('admin', PW)
  await http.post('/v1/users').set(auth(admin)).send({ username: 'ursula', password: 'ursula-password-1', role: 'user' }).expect(201)
  user = await login('ursula', 'ursula-password-1')
})
afterAll(async () => {
  await app.close()
})

describe('config', () => {
  it('rejects invalid transfer ACLs and notify targets at startup', () => {
    expect(() => loadConfig({ ALLOW_AXFR_FROM: 'nonsense' } as NodeJS.ProcessEnv)).toThrow(/ALLOW_AXFR_FROM/)
    expect(() => loadConfig({ NOTIFY_TO: 'bad host' } as NodeJS.ProcessEnv)).toThrow(/NOTIFY_TO/)
  })

  it('exposes non-secret replication settings to admins and operators only', async () => {
    const res = await http.get('/v1/server/replication').set(auth(admin)).expect(200)
    expect(res.body).toEqual({ allowAxfrFrom: ['203.0.113.0/24'], notifyTo: ['192.0.2.50:53', '192.0.2.99:5353'], defaultNameservers: ['ns1.example.net'] })
    await http.get('/v1/server/replication').set(auth(user)).expect(403)
  })
})

describe('zone file import', () => {
  const file = `$ORIGIN imp.test.
$TTL 1h
@ IN SOA ns1.imp.test. hostmaster.imp.test. ( 2026010101 2h 30m 1w 5m )
  IN NS ns1
  IN A 192.0.2.1
  IN MX 10 mail
www 5m IN CNAME @
mail IN A 192.0.2.25
@ IN DNSKEY 257 3 13 AAAA
`
  it('previews without writing anything', async () => {
    const res = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: file, dryRun: true }).expect(200)
    expect(res.body).toMatchObject({
      dryRun: true,
      ok: true,
      zone: 'imp.test',
      records: 5,
      byType: { NS: 1, A: 2, MX: 1, CNAME: 1 },
      serial: 2026010101,
      skipped: { DNSKEY: 1 },
      problems: [],
    })
    await http.get('/v1/zones/imp.test').set(auth(admin)).expect(404)
  })

  it('creates the zone, keeps the file SOA serial, and serves it immediately', async () => {
    const res = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: file }).expect(200)
    expect(res.body.zoneDetail.serial).toBe(2026010101)
    expect(ask(app.get(ZoneIndex), 'www.imp.test', RType.A).answers.map((a) => a.text)).toEqual(['imp.test', '192.0.2.1'])
    const hist = await http.get('/v1/zones/imp.test/history').set(auth(admin))
    expect(hist.body[0]).toMatchObject({ action: 'zone.import', detail: { mode: 'create', records: 5 } })
  })

  it('refuses to overwrite by accident, and replaces on request while keeping SOA/NS the file omits', async () => {
    const dup = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: file }).expect(400)
    expect(dup.body.message).toMatch(/already exists/)
    const next = await http
      .post('/v1/zones/import')
      .set(auth(admin))
      .send({ name: 'imp.test', mode: 'replace', zonefile: '$ORIGIN imp.test.\n@ 60 A 198.51.100.7\nnew 60 TXT "hi"\n' })
      .expect(200)
    expect(next.body.replacing).toBe(5)
    const sets = next.body.zoneDetail.rrsets.map((r: { name: string; type: string }) => `${r.name} ${r.type}`).sort()
    expect(sets).toEqual(['imp.test A', 'imp.test NS', 'imp.test SOA', 'new.imp.test TXT'])
    expect(ask(app.get(ZoneIndex), 'mail.imp.test', RType.A).rcode).toBe(3)
  })

  it('reports every problem with line numbers and writes nothing', async () => {
    const bad = '$ORIGIN bad.test.\n@ A 999.1.1.1\nx MX nope\n$INCLUDE f\n'
    const dry = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: bad, dryRun: true }).expect(200)
    expect(dry.body.ok).toBe(false)
    expect(dry.body.problems.some((p: string) => p.startsWith('line 3:'))).toBe(true)
    const real = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: bad }).expect(400)
    expect(real.body.message).toMatch(/line 3/)
    await http.get('/v1/zones/bad.test').set(auth(admin)).expect(404)
  })

  it('needs a zone name, rejects a mismatched $ORIGIN, and needs NS records or nameservers', async () => {
    const noOrigin = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: 'a.b.c. A 1.1.1.1\n', dryRun: true })
    expect(noOrigin.body.problems.join(' ')).toMatch(/zone name is unknown/)
    const mismatch = await http.post('/v1/zones/import').set(auth(admin)).send({ name: 'other.test', zonefile: '$ORIGIN x.test.\n@ A 1.1.1.1\n', dryRun: true })
    expect(mismatch.body.problems.join(' ')).toMatch(/does not match/)
    // This server has DEFAULT_NS, so a file without NS records is fine and gets those nameservers
    // (the case with no default is in import-nameservers.test.ts)
    await http.post('/v1/zones/import').set(auth(admin)).send({ name: 'nons.test', zonefile: '@ A 1.1.1.1\n' }).expect(200)
    expect((await http.get('/v1/zones/nons.test').set(auth(admin))).body.rrsets.map((r: { type: string }) => r.type)).toEqual(['A', 'NS', 'SOA'])
    await http.post('/v1/zones/import').set(auth(admin)).send({ name: 'nons2.test', nameservers: ['ns.nons2.test'], zonefile: '@ A 1.1.1.1\n' }).expect(200)
    const ns2 = (await http.get('/v1/zones/nons2.test').set(auth(admin))).body.rrsets.find((r: { type: string }) => r.type === 'NS')
    expect(ns2.records.map((r: { content: string }) => r.content)).toEqual(['ns.nons2.test']) // the request's nameservers win over the default
  })

  it('accepts a large file (body limit raised) and is limited to admins and operators', async () => {
    const lines = Array.from({ length: 12_000 }, (_, i) => `host${i} 300 IN A 10.${i >> 8 & 255}.${i & 255}.1`).join('\n')
    const big = `$ORIGIN big.test.\n@ NS ns1\n${lines}\n`
    expect(big.length).toBeGreaterThan(300_000)
    const res = await http.post('/v1/zones/import').set(auth(admin)).send({ zonefile: big }).expect(200)
    expect(res.body.records).toBe(12_001)
    await http.post('/v1/zones/import').set(auth(user)).send({ zonefile: big, name: 'big2.test' }).expect(403)
  })
})

describe('secondary zones via the API', () => {
  it('creates one, starts the first transfer on its own, and shows status', async () => {
    const res = await http.post('/v1/zones').set(auth(admin)).send({ name: 'sec.test', kind: 'slave', masters: ['192.0.2.10'] }).expect(201)
    expect(res.body).toMatchObject({ kind: 'slave', masters: ['192.0.2.10'] })
    await vi.waitFor(async () => {
      const z = (await http.get('/v1/zones/sec.test').set(auth(admin))).body
      expect(z.serial).toBe(2026101599)
    })
    const z = (await http.get('/v1/zones/sec.test').set(auth(admin))).body
    expect(z).toMatchObject({ transferError: null, lastTransfer: expect.any(String) })
    expect(ask(app.get(ZoneIndex), 'www.sec.test', RType.A).answers[0]!.text).toBe('192.0.2.8')
    const hist = await http.get('/v1/zones/sec.test/history').set(auth(admin))
    expect(hist.body.find((e: { action: string }) => e.action === 'zone.transfer').detail).toMatchObject({ source: '192.0.2.10:53', skipped: { DNSKEY: 1 } })
  })

  it('needs primaries, is read-only, and lists as a secondary', async () => {
    await http.post('/v1/zones').set(auth(admin)).send({ name: 'nomast.test', kind: 'slave' }).expect(400)
    const ro = await http
      .patch('/v1/zones/sec.test/rrsets')
      .set(auth(admin))
      .send({ rrsets: [{ name: 'x.sec.test', type: 'A', ttl: 60, records: [{ content: '1.1.1.1' }] }] })
      .expect(400)
    expect(ro.body.message).toMatch(/secondary zone/)
    const list = (await http.get('/v1/zones').set(auth(admin))).body
    expect(list.find((z: { name: string }) => z.name === 'sec.test')).toMatchObject({ kind: 'slave', masters: ['192.0.2.10'] })
  })

  it('retrieve transfers now, and surfaces primary failures as 502 with the reason', async () => {
    const ok = await http.post('/v1/zones/sec.test/retrieve').set(auth(admin)).expect(200)
    expect(ok.body).toMatchObject({ updated: true, serial: 2026101599, records: 2 })
    failTransfers = true
    const bad = await http.post('/v1/zones/sec.test/retrieve').set(auth(admin)).expect(502)
    expect(bad.body.message).toMatch(/connection refused/)
    expect((await http.get('/v1/zones/sec.test').set(auth(admin))).body.transferError).toMatch(/connection refused/)
    failTransfers = false
    await http.post('/v1/zones/sec.test/retrieve').set(auth(admin)).expect(200)
    await http.post('/v1/zones/imp.test/retrieve').set(auth(admin)).expect(400) // not a secondary
  })

  it('changes primaries', async () => {
    const res = await http.patch('/v1/zones/sec.test').set(auth(admin)).send({ masters: ['192.0.2.11:5353', 'ns.example.net'] }).expect(200)
    expect(res.body.masters).toEqual(['192.0.2.11:5353', 'ns.example.net'])
    await http.patch('/v1/zones/sec.test').set(auth(admin)).send({ masters: ['bad host'] }).expect(400)
    await http.patch('/v1/zones/imp.test').set(auth(admin)).send({ masters: ['192.0.2.11'] }).expect(400)
    await http.patch('/v1/zones/sec.test').set(auth(admin)).send({}).expect(400)
  })
})

describe('promotion via the API', () => {
  it('promotes a secondary, after which it accepts edits; and guards the request', async () => {
    await http.post('/v1/zones').set(auth(admin)).send({ name: 'promo.test', kind: 'slave', masters: ['192.0.2.10'] }).expect(201)
    await vi.waitFor(async () => expect((await http.get('/v1/zones/promo.test').set(auth(admin))).body.recordCount).toBeGreaterThan(0))
    await http.patch('/v1/zones/promo.test').set(auth(user)).send({ kind: 'master' }).expect(403)
    await http.patch('/v1/zones/promo.test').set(auth(admin)).send({ kind: 'master', masters: ['192.0.2.1'] }).expect(400)
    const res = await http.patch('/v1/zones/promo.test').set(auth(admin)).send({ kind: 'master' }).expect(200)
    expect(res.body).toMatchObject({ kind: 'master', masters: [] })
    await http.patch('/v1/zones/promo.test/rrsets').set(auth(admin)).send({ rrsets: [{ name: 'x.promo.test', type: 'A', ttl: 60, records: [{ content: '1.1.1.1' }] }] }).expect(200)
    await http.patch('/v1/zones/promo.test').set(auth(admin)).send({ kind: 'master' }).expect(400) // already primary
    await http.post('/v1/zones').set(auth(admin)).send({ name: 'unfinished.test', kind: 'slave', masters: ['192.0.2.10'] }).expect(201)
  })
})

describe('NOTIFY and permissions', () => {
  it('notifies the configured secondaries and reports who acknowledged', async () => {
    sent.length = 0
    const res = await http.post('/v1/zones/imp.test/notify').set(auth(admin)).expect(200)
    expect(res.body.targets).toEqual([
      { target: '192.0.2.50:53', acked: true },
      { target: '192.0.2.99:5353', acked: false },
    ])
    expect(sent).toEqual([{ host: '192.0.2.50', port: 53 }, { host: '192.0.2.99', port: 5353 }])
  })

  it('sends NOTIFY automatically after a change (debounced) but not for read-only operations', async () => {
    sent.length = 0
    await http.patch('/v1/zones/imp.test/rrsets').set(auth(admin)).send({ rrsets: [{ name: 'n.imp.test', type: 'A', ttl: 60, records: [{ content: '1.2.3.4' }] }] }).expect(200)
    await http.get('/v1/zones/imp.test').set(auth(admin)).expect(200)
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    expect(new Set(sent.map((s) => s.host))).toEqual(new Set(['192.0.2.50', '192.0.2.99']))
  })

  it('keeps plain users out of replication and import controls', async () => {
    await http.post('/v1/zones/imp.test/notify').set(auth(user)).expect(403)
    await http.post('/v1/zones/sec.test/retrieve').set(auth(user)).expect(403)
    await http.patch('/v1/zones/sec.test').set(auth(user)).send({ masters: ['192.0.2.1'] }).expect(403)
    await http.post('/v1/zones').set(auth(user)).send({ name: 'u.test', kind: 'slave', masters: ['192.0.2.1'] }).expect(403)
  })
})
