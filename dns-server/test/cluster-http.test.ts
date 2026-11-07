import 'reflect-metadata'
import net from 'node:net'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { hashPassword } from '../src/auth/password.js'
import { configure } from '../src/bootstrap.js'
import { CLUSTER, type ClusterRuntime } from '../src/cluster/cluster.runtime.js'
import { open, seal } from '../src/cluster/envelope.js'
import { PeerGate } from '../src/cluster/peer-gate.js'
import { parsePeerAddress } from '../src/cluster/peer-address.js'
import { loadConfig } from '../src/config/config.js'
import { RType } from '../src/dns/types.js'
import { UsersRepository } from '../src/users/users.repository.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ask } from './helpers.js'

const SECRET = 'cluster-secret-for-the-test-0123456789abcdef'
const PASSWORD = 'correct-horse-battery'

interface Node {
  id: string
  port: number
  app: INestApplication
  http: ReturnType<typeof request>
  token: string
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function startNode(id: string, port: number, peerPorts: number[], secret = SECRET): Promise<Node> {
  const cfg = loadConfig({
    DB_PATH: ':memory:',
    ADMIN_PASSWORD: PASSWORD,
    CLUSTER_SECRET: secret,
    CLUSTER_NODE_ID: id,
    CLUSTER_PEERS: peerPorts.map((p) => `127.0.0.1:${p}`).join(','),
    CLUSTER_SYNC_SECONDS: '1',
    API_PORT: String(port),
  } as NodeJS.ProcessEnv)
  const mod = await Test.createTestingModule({ imports: [AppModule.register(cfg)] }).compile()
  const app = configure(mod.createNestApplication())
  await app.init()
  await app.listen(port, '127.0.0.1')
  const http = request(`http://127.0.0.1:${port}`)
  const token = (await http.post('/v1/auth/login').send({ username: 'admin', password: PASSWORD })).body.token as string
  return { id, port, app, http, token }
}

const auth = (n: Node) => ({ Authorization: `Bearer ${n.token}` })
const zoneNames = async (n: Node) => ((await n.http.get('/v1/zones').set(auth(n))).body as { name: string }[]).map((z) => z.name).sort()
const eventually = (fn: () => Promise<void> | void) => vi.waitFor(fn, { timeout: 8000, interval: 100 })

let a: Node
let b: Node
let c: Node
let outsider: Node

beforeAll(async () => {
  const [pa, pb, pc, pd] = [await freePort(), await freePort(), await freePort(), await freePort()]
  a = await startNode('ns1', pa, [pb, pc])
  b = await startNode('ns2', pb, [pa, pc])
  c = await startNode('ns3', pc, [pa, pb])
  // a node that knows the right addresses but has the wrong secret
  outsider = await startNode('intruder', pd, [pa], 'a-completely-different-secret-0123456789abcdef')
}, 60_000)

afterAll(async () => {
  for (const n of [a, b, c, outsider]) await n?.app.close()
})

describe('three real servers', () => {
  it('a zone created through one node shows up on the others, quickly, without waiting for the sync interval', async () => {
    const t0 = Date.now()
    await a.http.post('/v1/zones').set(auth(a)).send({ name: 'live.test', nameservers: ['ns1.live.test'], rrsets: [{ name: 'www.live.test', type: 'A', ttl: 60, records: [{ content: '192.0.2.1' }] }] }).expect(201)
    await eventually(async () => {
      expect(await zoneNames(b)).toEqual(['live.test'])
      expect(await zoneNames(c)).toEqual(['live.test'])
    })
    expect(Date.now() - t0).toBeLessThan(6000)
    for (const n of [b, c]) {
      expect(ask(n.app.get(ZoneIndex), 'www.live.test', RType.A).answers[0]!.text).toBe('192.0.2.1')
    }
  })

  it('edits on any node reach all the others, and deletions too', async () => {
    await b.http.patch('/v1/zones/live.test/rrsets').set(auth(b)).send({ rrsets: [{ name: 'from-b.live.test', type: 'A', ttl: 60, records: [{ content: '192.0.2.2' }] }] }).expect(200)
    await c.http.patch('/v1/zones/live.test/rrsets').set(auth(c)).send({ rrsets: [{ name: 'from-c.live.test', type: 'TXT', ttl: 60, records: [{ content: '"hello"' }] }] }).expect(200)
    await eventually(() => {
      for (const n of [a, b, c]) {
        const idx = n.app.get(ZoneIndex)
        expect(ask(idx, 'from-b.live.test', RType.A).answers).toHaveLength(1)
        expect(ask(idx, 'from-c.live.test', RType.TXT).answers).toHaveLength(1)
      }
    })
    await b.http.delete('/v1/zones/live.test').set(auth(b)).expect(204)
    await eventually(async () => {
      expect(await zoneNames(a)).toEqual([])
      expect(await zoneNames(c)).toEqual([])
    })
  })

  it('users replicate, and a login token from one node is valid on another, resolved by name even when ids differ', async () => {
    // Create different users on two nodes at the same moment, so their numeric ids cross over. Both inserts happen in one
    // synchronous step (hashes are made beforehand): replication needs the event loop, so neither node can hear about the
    // other's user first, however slow the machine is. Going through the HTTP API made this a race.
    const [hashFirst, hashSecond] = [await hashPassword('first-password-1'), await hashPassword('second-password-1')]
    a.app.get(UsersRepository).create('first', hashFirst, 'operator')
    b.app.get(UsersRepository).create('second', hashSecond, 'user')
    for (const n of [a, b]) n.app.get<ClusterRuntime | null>(CLUSTER)?.service.smallTouched()
    await eventually(async () => {
      for (const n of [a, b, c]) {
        const names = ((await n.http.get('/v1/users').set(auth(n))).body as { username: string }[]).map((u) => u.username).sort()
        expect(names).toEqual(['admin', 'first', 'second'])
      }
    })
    const idOf = async (n: Node, name: string) => ((await n.http.get('/v1/users').set(auth(n))).body as { id: number; username: string }[]).find((u) => u.username === name)!.id
    expect(await idOf(a, 'first')).not.toBe(await idOf(b, 'first')) // ids really do differ between nodes
    const firstOnA = (await a.http.post('/v1/auth/login').send({ username: 'first', password: 'first-password-1' })).body.token as string
    const me = await b.http.get('/v1/auth/me').set({ Authorization: `Bearer ${firstOnA}` }).expect(200)
    expect(me.body).toMatchObject({ username: 'first', role: 'operator' }) // not whoever has that id on ns2
    const second = (await b.http.post('/v1/auth/login').send({ username: 'second', password: 'second-password-1' })).body.token as string
    expect((await c.http.get('/v1/auth/me').set({ Authorization: `Bearer ${second}` })).body.username).toBe('second')
  })

  it('a dynamic DNS token created on one node updates a record through another', async () => {
    await a.http.post('/v1/zones').set(auth(a)).send({ name: 'dyn.test', nameservers: ['ns1.dyn.test'] }).expect(201)
    await eventually(async () => expect(await zoneNames(b)).toContain('dyn.test'))
    const { token } = (await a.http.post('/v1/zones/dyn.test/dyndns').set(auth(a)).send({ name: 'home.dyn.test' }).expect(201)).body
    await eventually(async () => expect((await b.http.get('/v1/zones/dyn.test/dyndns').set(auth(b))).body).toHaveLength(1))
    await b.http.get('/dyn/update').query({ token, ip: '203.0.113.44' }).expect(200)
    await eventually(() => {
      for (const n of [a, c]) expect(ask(n.app.get(ZoneIndex), 'home.dyn.test', RType.A).answers[0]?.text).toBe('203.0.113.44')
    })
  })

  it('DNSSEC keys replicate, so any node answers with the same signed data', async () => {
    await a.http.post('/v1/zones/dyn.test/dnssec').set(auth(a)).expect(200)
    await eventually(async () => {
      for (const n of [b, c]) expect((await n.http.get('/v1/zones/dyn.test/dnssec').set(auth(n))).body.enabled).toBe(true)
    })
    const tag = async (n: Node) => (await n.http.get('/v1/zones/dyn.test/dnssec').set(auth(n))).body.keys[0].keyTag
    expect(await tag(b)).toBe(await tag(a))
    expect(await tag(c)).toBe(await tag(a))
  })

  it('the admin status shows peers, last contact and sequence numbers; "sync now" works', async () => {
    const s = (await a.http.get('/v1/cluster').set(auth(a)).expect(200)).body
    expect(s).toMatchObject({ enabled: true, nodeId: 'ns1' })
    expect(s.peers).toHaveLength(2)
    for (const p of s.peers) expect(p).toMatchObject({ lastError: null, lastContact: expect.any(String), nodeId: expect.stringMatching(/^ns[23]$/) })
    expect(s.entities).toBeGreaterThan(0)
    const r = (await a.http.post('/v1/cluster/sync').set(auth(a)).expect(200)).body
    expect(r.results.every((x: { ok: boolean }) => x.ok)).toBe(true)
    await a.http.get('/v1/cluster').expect(401)
  })
})

describe('the cluster endpoints', () => {
  const sealed = (route: string, body: object, secret = SECRET, ctx = `cluster.${route}.req`) => ({ d: seal(secret, ctx, body) })

  it('answer a peer that knows the secret, with an encrypted body that only the secret opens', async () => {
    const res = await a.http.post('/cluster/v1/changes').send(sealed('changes', { since: 0, limit: 5 })).expect(200)
    expect(JSON.stringify(res.body)).not.toContain('live.test')
    const out = open<{ nodeId: string; entities: { key: string }[] }>(SECRET, 'cluster.changes.res', res.body.d)
    expect(out.nodeId).toBe('ns1')
    expect(out.entities.length).toBeGreaterThan(0)
    expect(() => open('another-secret-another-secret-another!', 'cluster.changes.res', res.body.d)).toThrow()
  })

  it('refuse everything else with the same blank 403: no body, wrong secret, wrong route, stale message', async () => {
    const attempts = [
      a.http.post('/cluster/v1/changes').send({}),
      a.http.post('/cluster/v1/changes').send({ d: 'junk' }),
      a.http.post('/cluster/v1/changes').send(sealed('changes', { since: 0 }, 'another-secret-another-secret-another!')),
      a.http.post('/cluster/v1/changes').send(sealed('changes', { since: 0 }, SECRET, 'cluster.nudge.req')),
      a.http.post('/cluster/v1/changes').send({ d: seal(SECRET, 'cluster.changes.req', { since: 0 }, Date.now() - 3600_000) }),
    ]
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(403)
      expect(r.body).toEqual({ statusCode: 403, message: 'forbidden' })
    }
  })

  it('are not reachable with a login token: peers are authenticated by secret and address, not by user accounts', async () => {
    await a.http.post('/cluster/v1/changes').set(auth(a)).send({}).expect(403)
  })

  it('a node with the wrong secret cannot read from, or write to, the cluster; the failure is explained on its side', async () => {
    await eventually(async () => {
      const s = (await outsider.http.get('/v1/cluster').set(auth(outsider))).body
      expect(s.peers[0].lastError).toMatch(/refused|did not verify/)
      expect(s.peers[0].lastContact).toBeNull()
    })
    expect(await zoneNames(outsider)).toEqual([]) // nothing leaked into it
    expect(await zoneNames(a)).not.toContain('intruder') // and nothing came out of it
  })
})

describe('the peer gate', () => {
  const peers = [parsePeerAddress('ns2.example.com', 8081), parsePeerAddress('203.0.113.9:8081', 8081)]
  const lookups: Record<string, string[]> = { 'ns2.example.com': ['198.51.100.2', '2001:db8::2'] }
  const mk = (allowFrom: string[] = [], lookup = async (h: string) => lookups[h] ?? []) => new PeerGate(SECRET, peers, allowFrom, lookup)

  it('allows the peers’ resolved addresses, literal addresses, and explicit networks, and nothing else', async () => {
    const g = mk(['10.1.0.0/16'])
    await g.refresh()
    for (const ok of ['198.51.100.2', '::ffff:198.51.100.2', '2001:db8::2', '203.0.113.9', '10.1.5.5']) expect(g.allowed(ok), ok).toBe(true)
    for (const no of ['198.51.100.3', '203.0.113.10', '10.2.0.1', '127.0.0.1', undefined]) expect(g.allowed(no), String(no)).toBe(false)
  })

  it('refuses a request from an allowed address that lacks the secret, and one with the secret from a stranger', async () => {
    const g = mk()
    await g.refresh()
    const good = seal(SECRET, 'cluster.changes.req', { since: 0 })
    expect(g.openRequest('203.0.113.9', 'changes', good)).toMatchObject({ since: 0 })
    expect(() => g.openRequest('203.0.113.9', 'changes', seal('x'.repeat(40), 'cluster.changes.req', {}))).toThrow()
    expect(() => g.openRequest('192.0.2.77', 'changes', good)).toThrow() // right secret, wrong place
  })

  it('keeps a peer’s known addresses when DNS fails, instead of locking it out', async () => {
    let fail = false
    const g = mk([], async (h) => {
      if (fail) throw new Error('SERVFAIL')
      return lookups[h] ?? []
    })
    await g.refresh()
    fail = true
    await g.refresh()
    expect(g.allowed('198.51.100.2')).toBe(true)
  })

  it('picks up a changed address on the next refresh', async () => {
    const l = { 'ns2.example.com': ['198.51.100.2'] }
    const g = new PeerGate(SECRET, [peers[0]!], [], async (h) => l[h as keyof typeof l] ?? [])
    await g.refresh()
    l['ns2.example.com'] = ['198.51.100.99']
    await g.refresh()
    expect(g.allowed('198.51.100.2')).toBe(false)
    expect(g.allowed('198.51.100.99')).toBe(true)
  })
})
