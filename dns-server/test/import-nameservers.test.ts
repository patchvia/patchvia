import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { configure } from '../src/bootstrap.js'
import { loadConfig } from '../src/config/config.js'

const PW = 'import-ns-password-1'
let app: INestApplication
let http: ReturnType<typeof request>
let h: { Authorization: string }

// No DEFAULT_NS here: a zone has to bring its own nameservers
beforeAll(async () => {
  const cfg = loadConfig({ DB_PATH: ':memory:', ADMIN_PASSWORD: PW } as NodeJS.ProcessEnv)
  app = configure((await Test.createTestingModule({ imports: [AppModule.register(cfg)] }).compile()).createNestApplication())
  await app.init()
  http = request(app.getHttpServer())
  h = { Authorization: `Bearer ${(await http.post('/v1/auth/login').send({ username: 'admin', password: PW })).body.token}` }
})
afterAll(async () => {
  await app.close()
})

describe('importing a zone with no NS records and no DEFAULT_NS', () => {
  const file = '@ A 192.0.2.1\n'
  it('the dry run says so, instead of reporting ok and failing at the real import', async () => {
    const dry = await http.post('/v1/zones/import').set(h).send({ name: 'nons.test', zonefile: file, dryRun: true }).expect(200)
    expect(dry.body.ok).toBe(false)
    expect(dry.body.problems.join(' ')).toMatch(/no NS records.*DEFAULT_NS/)
    const real = await http.post('/v1/zones/import').set(h).send({ name: 'nons.test', zonefile: file }).expect(400)
    expect(real.body.message).toMatch(/no NS records/)
    await http.get('/v1/zones/nons.test').set(h).expect(404) // nothing was created
  })
  it('is fine when the request brings nameservers, or the file has its own NS records', async () => {
    const withNs = await http.post('/v1/zones/import').set(h).send({ name: 'a.test', nameservers: ['ns.a.test'], zonefile: file, dryRun: true })
    expect(withNs.body.ok).toBe(true)
    const own = await http.post('/v1/zones/import').set(h).send({ name: 'b.test', zonefile: '@ NS ns.elsewhere.test.\n@ A 192.0.2.1\n', dryRun: true })
    expect(own.body.ok).toBe(true)
    await http.post('/v1/zones/import').set(h).send({ name: 'a.test', nameservers: ['ns.a.test'], zonefile: file }).expect(200)
  })
  it('replacing an existing zone never needs nameservers', async () => {
    const res = await http.post('/v1/zones/import').set(h).send({ name: 'a.test', mode: 'replace', zonefile: '@ A 192.0.2.77\n', dryRun: true })
    expect(res.body.ok).toBe(true)
  })
})
