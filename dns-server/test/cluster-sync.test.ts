import { describe, expect, it } from 'vitest'
import { verifyPassword } from '../src/auth/password.js'
import { canonical, hashOf, key, type WireEntity } from '../src/cluster/entities.js'
import { formatHlc } from '../src/cluster/hlc.js'
import { buildSnapshot } from '../src/cluster/snapshot.js'
import { RType } from '../src/dns/types.js'
import { parseRrsig, verifyRRset } from '../src/dnssec/sign.js'
import { ConflictError } from '../src/zones/zone-service.js'
import { ask, parseResponse } from './helpers.js'
import { encodeQuery } from '../src/dns/codec.js'
import { handlePacket } from '../src/dns/handler.js'
import { Net, TestNode, allConverged, rec, trio } from './cluster-harness.js'

const mkZone = (n: TestNode, name = 'z.test', ns = ['ns1.z.test']) => n.zones.createZone({ name, nameservers: ns }, { actor: 'test' })
const seqs = (nodes: TestNode[]) => nodes.map((n) => n.store.maxSeq())
const answers = (n: TestNode, name: string, type: number) => ask(n.index, name, type).answers.map((a) => a.text)

describe('basic replication', () => {
  it('a zone and its records created on one node appear, and are served, on the others', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'www.z.test', 'A', 300, rec('192.0.2.1', '192.0.2.2'))
    a.zones.setRRset('z.test', 'z.test', 'MX', 3600, rec('10 mail.z.test'))
    a.cluster.capture()
    await net.sync()
    for (const n of [b, c]) {
      expect(answers(n, 'www.z.test', RType.A).sort()).toEqual(['192.0.2.1', '192.0.2.2'])
      expect(answers(n, 'z.test', RType.MX)).toEqual(['10 mail.z.test'])
      expect(n.zones.getZone('z.test')).toMatchObject({ kind: 'native', recordCount: 4 })
    }
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('repeating syncs changes nothing: no spurious local operations, no sequence growth', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'www.z.test', 'A', 300, rec('192.0.2.1'))
    await net.sync()
    const before = seqs([a, b, c])
    await net.sync(4)
    expect(seqs([a, b, c])).toEqual(before)
    for (const n of [a, b, c]) expect(n.cluster.capture({ small: true, zones: 'all' })).toBe(0)
  })

  it('SOA serials are per node and still move forward on every node that receives a change', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    await net.sync()
    const serial = (n: TestNode) => n.index.get('z.test')!.serial
    const before = [a, b, c].map(serial)
    a.advance(1000)
    a.zones.setRRset('z.test', 'x.z.test', 'A', 60, rec('192.0.2.9'))
    await net.sync()
    ;[a, b, c].forEach((n, i) => expect(serial(n)).toBeGreaterThan(before[i]!))
    expect(allConverged([a, b, c])).toBe(true) // yet the replicated data is identical: serials are not part of it
  })

  it('deleting a record set propagates; so does changing a TTL or disabling a record', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 300, rec('192.0.2.1'))
    await net.sync()
    a.advance(10)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, [{ content: '192.0.2.1', disabled: true }])
    await net.sync()
    expect(b.zones.getRRsets('z.test').find((s) => s.name === 'w.z.test')).toMatchObject({ ttl: 60, records: [{ disabled: true }] })
    a.advance(10)
    a.zones.deleteRRset('z.test', 'w.z.test', 'A')
    await net.sync()
    expect(b.zones.getRRsets('z.test').some((s) => s.name === 'w.z.test')).toBe(false)
    expect(ask(b.index, 'w.z.test', RType.A).rcode).toBe(3)
  })

  it('zone properties replicate: account ownership, and secondary zones as secondaries without their records', async () => {
    const { net, a, b } = trio()
    a.users.createAccount('acme', 'Acme')
    mkZone(a)
    a.zones.setZoneAccount('z.test', a.users.listAccounts()[0]!.id)
    a.zones.createZone({ name: 'copy.test', kind: 'slave', nameservers: [], masters: ['192.0.2.50'] })
    await net.sync()
    expect(b.zones.getZone('z.test').accountId).toBe(b.users.listAccounts()[0]!.id)
    expect(b.zones.getZone('copy.test')).toMatchObject({ kind: 'slave', masters: ['192.0.2.50'] })
    expect(b.zones.getRRsets('copy.test')).toEqual([]) // records of a secondary come from its primary, per node
  })
})

describe('concurrent changes', () => {
  it('different record sets edited on different nodes both survive', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    await net.sync()
    a.zones.setRRset('z.test', 'a.z.test', 'A', 60, rec('192.0.2.1'))
    b.zones.setRRset('z.test', 'b.z.test', 'A', 60, rec('192.0.2.2'))
    c.zones.setRRset('z.test', 'c.z.test', 'TXT', 60, rec('"from c"'))
    await net.sync()
    for (const n of [a, b, c]) {
      expect(answers(n, 'a.z.test', RType.A)).toEqual(['192.0.2.1'])
      expect(answers(n, 'b.z.test', RType.A)).toEqual(['192.0.2.2'])
      expect(answers(n, 'c.z.test', RType.TXT)).toEqual(['from c'])
    }
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('the same record set edited twice: the later change wins everywhere', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    await net.sync()
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.1'))
    b.advance(5000)
    b.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.2'))
    await net.sync()
    for (const n of [a, b, c]) expect(answers(n, 'w.z.test', RType.A)).toEqual(['192.0.2.2'])
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('a true tie (same instant, same counter) is broken the same way on every node, in either arrival order: higher node id wins', () => {
    const { a, b } = trio()
    const same = { ms: 1_800_000_000_000, counter: 5 }
    const zone = (node: string, account: string) => ({
      key: key.zone('tie.test'),
      hlc: formatHlc({ ...same, node }),
      deleted: false,
      payload: canonical({ kind: 'native', masters: [], account }),
      seq: 1,
    })
    for (const n of [a, b]) for (const acct of ['from-ns1', 'from-ns3']) n.users.createAccount(acct, '')
    a.cluster.merge('x', [zone('ns1', 'from-ns1'), zone('ns3', 'from-ns3')])
    b.cluster.merge('x', [zone('ns3', 'from-ns3'), zone('ns1', 'from-ns1')]) // opposite order
    for (const n of [a, b]) expect(n.store.get(key.zone('tie.test'))!.hlc).toContain('.ns3')
    expect(a.zones.getZone('tie.test').accountId).toBe(a.users.listAccounts().find((x) => x.name === 'from-ns3')!.id)
  })

  it('causality beats wall clocks: a node that saw a change and then edits wins even if its clock is behind', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    await net.sync()
    a.advance(100_000)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync()
    b.t -= 50_000 // b's clock is far behind a's
    b.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.2')) // made after seeing a's change
    await net.sync()
    for (const n of [a, b]) expect(answers(n, 'w.z.test', RType.A)).toEqual(['192.0.2.2'])
  })

  it('the same zone created independently on two nodes merges instead of losing records', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    mkZone(b)
    a.zones.setRRset('z.test', 'only-a.z.test', 'A', 60, rec('192.0.2.1'))
    b.zones.setRRset('z.test', 'only-b.z.test', 'A', 60, rec('192.0.2.2'))
    await net.sync()
    for (const n of [a, b]) {
      expect(answers(n, 'only-a.z.test', RType.A)).toEqual(['192.0.2.1'])
      expect(answers(n, 'only-b.z.test', RType.A)).toEqual(['192.0.2.2'])
    }
    expect(allConverged([a, b])).toBe(true)
  })
})

describe('deleting zones', () => {
  it('a deleted zone disappears everywhere and stays deleted', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync()
    a.advance(100)
    a.zones.deleteZone('z.test')
    await net.sync()
    for (const n of [a, b, c]) {
      expect(n.zones.listZones()).toEqual([])
      expect(ask(n.index, 'w.z.test', RType.A).rcode).toBe(5) // REFUSED: no longer hosted
    }
    await net.sync(3)
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('a record added elsewhere while the zone was being deleted does not resurrect the zone', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    await net.sync()
    net.isolate('ns2')
    a.advance(1000)
    a.zones.deleteZone('z.test')
    b.advance(2000) // b's edit is later in time than a's delete
    b.zones.setRRset('z.test', 'late.z.test', 'A', 60, rec('192.0.2.7'))
    net.heal()
    await net.sync()
    expect(a.zones.listZones()).toEqual([])
    expect(b.zones.listZones()).toEqual([])
  })

  it('recreating a deleted zone brings back none of its old records', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'old.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync()
    a.advance(100)
    a.zones.deleteZone('z.test')
    await net.sync()
    a.advance(100)
    mkZone(a)
    a.zones.setRRset('z.test', 'new.z.test', 'A', 60, rec('192.0.2.2'))
    await net.sync()
    for (const n of [a, b, c]) {
      expect(n.zones.getRRsets('z.test').map((s) => s.name)).not.toContain('old.z.test')
      expect(answers(n, 'new.z.test', RType.A)).toEqual(['192.0.2.2'])
    }
    expect(allConverged([a, b, c])).toBe(true)
  })
})

describe('partitions, relays and catching up', () => {
  it('changes reach a node through another one when the two cannot talk directly', async () => {
    const { net, a, b, c } = trio()
    net.cut('ns1', 'ns3')
    mkZone(a)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync(4)
    expect(answers(c, 'w.z.test', RType.A)).toEqual(['192.0.2.1']) // relayed by ns2
    c.advance(10)
    c.zones.setRRset('z.test', 'back.z.test', 'A', 60, rec('192.0.2.5'))
    await net.sync(4)
    expect(answers(a, 'back.z.test', RType.A)).toEqual(['192.0.2.5'])
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('a node that was offline catches up, page by page', async () => {
    const net = new Net()
    const a = net.node('ns1', ['ns2'], { pageSize: 3 })
    const b = net.node('ns2', ['ns1'], { pageSize: 3 })
    net.isolate('ns2')
    mkZone(a)
    for (let i = 0; i < 25; i++) {
      a.advance(10)
      a.zones.setRRset('z.test', `h${i}.z.test`, 'A', 60, rec(`10.0.0.${i + 1}`))
    }
    net.calls = []
    net.heal()
    await b.cluster.syncAll()
    expect(b.zones.getZone('z.test').recordCount).toBe(1 + 25) // NS + hosts
    expect(allConverged([a, b])).toBe(true)
    expect(net.calls.length).toBeGreaterThan(8) // several pages
    expect(net.calls.map((x) => x.since)).toEqual([...net.calls.map((x) => x.since)].sort((x, y) => x - y)) // always moving forward
  })

  it('both sides edited during a partition: everything is merged once they reconnect', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    await net.sync()
    net.cut('ns1', 'ns2')
    net.cut('ns1', 'ns3')
    a.zones.setRRset('z.test', 'a1.z.test', 'A', 60, rec('192.0.2.1'))
    b.zones.setRRset('z.test', 'b1.z.test', 'A', 60, rec('192.0.2.2'))
    c.advance(10)
    c.zones.setRRset('z.test', 'b1.z.test', 'A', 60, rec('192.0.2.3')) // conflicts with b, later
    net.heal()
    await net.sync()
    for (const n of [a, b, c]) {
      expect(answers(n, 'a1.z.test', RType.A)).toEqual(['192.0.2.1'])
      expect(answers(n, 'b1.z.test', RType.A)).toEqual(['192.0.2.3'])
    }
  })

  it('an unreachable peer is recorded, does not stop the others, and recovers', async () => {
    const { net, a, b, c } = trio()
    net.isolate('ns3')
    mkZone(a)
    const res = await a.cluster.syncAll()
    expect(res.find((r) => r.peer === 'ns3')).toMatchObject({ ok: false, error: expect.stringContaining('unreachable') })
    expect(res.find((r) => r.peer === 'ns2')!.ok).toBe(true)
    expect(a.cluster.status().peers.find((p) => p.address === 'ns3')!.lastError).toMatch(/unreachable/)
    net.heal()
    await net.sync()
    expect(a.cluster.status().peers.find((p) => p.address === 'ns3')).toMatchObject({ lastError: null, nodeId: 'ns3' })
    expect(c.zones.listZones()).toHaveLength(1)
    expect(b.zones.listZones()).toHaveLength(1)
  })
})

describe('users, accounts and keys', () => {
  it('accounts, users with their account membership, and API keys replicate; passwords still verify', async () => {
    const { net, a, b } = trio()
    a.users.createAccount('acme', 'Acme Corp')
    const u = await a.addUser('dana', 'user', ['acme'])
    a.users.createKey({ userId: u.id, name: 'ci', prefix: 'dnk_abcdef', hash: 'h'.repeat(64), scope: 'write' })
    await net.sync()
    const dana = b.users.getByUsername('dana')!
    expect(dana).toMatchObject({ role: 'user', accountIds: [b.users.listAccounts()[0]!.id] })
    expect(await verifyPassword('password-for-dana', dana.passwordHash)).toBe(true)
    expect(b.users.getKeyByHash('h'.repeat(64))).toMatchObject({ name: 'ci', scope: 'write', userId: dana.id })
  })

  it('deleting a user, revoking a key, changing a role or password all replicate', async () => {
    const { net, a, b } = trio()
    const u = await a.addUser('eve', 'operator')
    a.users.createKey({ userId: u.id, name: 'k', prefix: 'dnk_1', hash: 'k'.repeat(64), scope: 'read' })
    await net.sync()
    a.advance(100)
    a.users.update(u.id, { role: 'admin' })
    await net.sync()
    expect(b.users.getByUsername('eve')!.role).toBe('admin')
    expect(b.users.getByUsername('eve')!.tokenVersion).toBe(a.users.getByUsername('eve')!.tokenVersion) // sessions invalidate everywhere
    a.advance(100)
    a.users.deleteKey(a.users.listKeys()[0]!.id)
    await net.sync()
    expect(b.users.getKeyByHash('k'.repeat(64))).toBeUndefined()
    a.advance(100)
    a.users.delete(u.id)
    await net.sync()
    expect(b.users.getByUsername('eve')).toBeUndefined()
  })

  it('an item that arrives before what it depends on waits, and is never mistaken for a deletion', async () => {
    const { a, b } = trio()
    const u = await a.addUser('late', 'user')
    a.users.createKey({ userId: u.id, name: 'k', prefix: 'dnk_2', hash: 'z'.repeat(64), scope: 'read' })
    a.cluster.capture()
    const all = a.store.changesSince(0, 100)
    const keyEntity = all.find((e) => e.key.startsWith('apikey:'))!
    const userEntity = all.find((e) => e.key.startsWith('user:'))!
    b.cluster.merge('ns1', [keyEntity]) // the key first: its user is unknown here
    expect(b.users.getKeyByHash('z'.repeat(64))).toBeUndefined()
    expect(b.cluster.capture({ small: true, zones: 'all' })).toBe(0) // must NOT tombstone the waiting key
    expect(b.store.get(keyEntity.key)!.deleted).toBe(false)
    b.cluster.merge('ns1', [userEntity]) // now its user arrives
    b.cluster.merge('ns1', [keyEntity]) // (a later pull would carry nothing new; reconcile re-runs on any merge)
    expect(b.users.getKeyByHash('z'.repeat(64))).toBeDefined()
  })

  it('a dynamic DNS token created on one node can be used on another, and its update reaches the third', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    const { token } = a.dyn.create('z.test', { name: 'home.z.test', ttl: 30 })
    await net.sync()
    expect(b.dyn.update(token, ['203.0.113.7'], '1.1.1.1')).toMatchObject({ status: 'good' })
    await net.sync()
    expect(answers(c, 'home.z.test', RType.A)).toEqual(['203.0.113.7'])
    expect(answers(a, 'home.z.test', RType.A)).toEqual(['203.0.113.7'])
    // the secret itself never left any node in the clear: only its hash is stored and replicated
    expect(JSON.stringify(c.store.changesSince(0, 1000))).not.toContain(token)
  })
})

describe('DNSSEC across the cluster', () => {
  it('every node signs with the same key, so a validator gets valid answers from whichever node it asks', async () => {
    const { net, a, b, c } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'www.z.test', 'A', 300, rec('192.0.2.1'))
    a.zones.enableDnssec('z.test')
    await net.sync()
    const tags = [a, b, c].map((n) => n.zones.dnssecStatus('z.test').keys.map((k) => k.keyTag))
    expect(tags[1]).toEqual(tags[0])
    expect(tags[2]).toEqual(tags[0])

    const dnskey = a.zones.dnssecStatus('z.test').keys[0]!
    const pub = Buffer.from(dnskey.dnskey.split(' ')[3]!, 'base64')
    for (const n of [b, c]) {
      const r = parseResponse(handlePacket(n.index, encodeQuery(1, 'www.z.test', RType.A, { edns: 4096, do: true }), 'tcp')!)
      const sig = r.answers.find((x) => x.type === RType.RRSIG)!
      const set = { name: 'www.z.test', type: RType.A as number, ttl: 300, rdatas: [{ wire: r.answers.find((x) => x.type === RType.A)!.rdata }] }
      expect(verifyRRset({ flags: 257, algorithm: 13, publicKey: pub }, sig.rdata, set, Math.floor(Date.now() / 1000))).toBeNull()
      expect(parseRrsig(sig.rdata).keyTag).toBe(dnskey.keyTag)
    }
    expect(allConverged([a, b, c])).toBe(true)
  })

  it('a record changed on another node is signed there with the shared key', async () => {
    const { net, a, c } = trio()
    mkZone(a)
    a.zones.enableDnssec('z.test')
    await net.sync()
    c.advance(100)
    c.zones.setRRset('z.test', 'new.z.test', 'A', 60, rec('192.0.2.9'))
    await net.sync()
    const r = parseResponse(handlePacket(a.index, encodeQuery(1, 'new.z.test', RType.A, { edns: 4096, do: true }), 'tcp')!)
    expect(r.answers.map((x) => x.type)).toEqual([RType.A, RType.RRSIG])
  })

  it('key rollover and turning DNSSEC off replicate', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    a.zones.enableDnssec('z.test')
    await net.sync()
    a.advance(100)
    const added = a.zones.addDnssecKey('z.test').keys.find((k) => !k.active)!
    await net.sync()
    expect(b.zones.dnssecStatus('z.test').keys).toHaveLength(2)
    a.advance(100)
    a.zones.updateDnssecKey('z.test', a.zones.dnssecStatus('z.test').keys.find((k) => k.keyTag === added.keyTag)!.id, { active: true })
    await net.sync()
    expect(b.zones.dnssecStatus('z.test').keys.filter((k) => k.active)).toHaveLength(2)
    a.advance(100)
    a.zones.disableDnssec('z.test')
    await net.sync()
    expect(b.zones.dnssecStatus('z.test').enabled).toBe(false)
    expect(b.index.get('z.test')!.signed).toBe(false)
  })

  it('a zone whose keys are only partly delivered keeps serving its previous version', async () => {
    const { a, b } = trio()
    mkZone(a)
    a.zones.enableDnssec('z.test')
    a.cluster.capture()
    const all = a.store.changesSince(0, 1000)
    const withoutKey = all.filter((e) => !e.key.startsWith('dnssec:'))
    b.cluster.merge('ns1', withoutKey)
    expect(b.index.get('z.test')!.signed).toBe(false) // served unsigned for now, not broken
    b.cluster.merge('ns1', all.filter((e) => e.key.startsWith('dnssec:')))
    expect(b.index.get('z.test')!.signed).toBe(true)
  })
})

describe('hostile and broken input', () => {
  const entity = (over: Partial<WireEntity>): WireEntity => {
    const payload = canonical({ kind: 'native', masters: [], account: null })
    return { key: key.zone('evil.test'), hlc: formatHlc({ ms: 1_800_000_000_000, counter: 0, node: 'x' }), deleted: false, payload, seq: 1, ...over }
  }

  it('rejects malformed keys, non-canonical or oversized payloads, and timestamps from a node with a wrong clock', () => {
    const { a } = trio()
    const farFuture = formatHlc({ ms: 1_800_000_000_000 + 5 * 86_400_000, counter: 0, node: 'x' })
    const bad = [
      entity({ key: 'nonsense' }),
      entity({ key: 'bogus:thing' }),
      entity({ payload: '{"b":1,"a":2}' }), // not canonical
      entity({ payload: 'not json' }),
      entity({ payload: 'x'.repeat(2_100_000) }),
      entity({ hlc: farFuture }),
      entity({ hlc: 'garbage' }),
    ]
    const r = a.cluster.merge('x', bad)
    expect(r).toMatchObject({ received: 7, applied: 0, rejected: 7 })
    expect(a.zones.listZones()).toEqual([])
  })

  it('skips records that do not validate, but still applies the rest', () => {
    const { a } = trio()
    const ok = (k: string, p: object) => entity({ key: k, payload: canonical(p) })
    const r = a.cluster.merge('x', [
      ok(key.zone('v.test'), { kind: 'native', masters: [], account: null }),
      ok(key.rrset('v.test', 'v.test', 'SOA'), { ttl: 3600, records: [{ c: 'ns.v.test h.v.test 0 1 1 1 60', d: false }] }),
      ok(key.rrset('v.test', 'v.test', 'NS'), { ttl: 3600, records: [{ c: 'ns.v.test', d: false }] }),
      ok(key.rrset('v.test', 'bad.v.test', 'A'), { ttl: 60, records: [{ c: 'not-an-ip', d: false }] }),
      ok(key.rrset('v.test', 'good.v.test', 'A'), { ttl: 60, records: [{ c: '192.0.2.1', d: false }] }),
    ])
    expect(r.applied).toBe(5)
    expect(a.zones.getRRsets('v.test').map((s) => s.name)).toEqual(expect.arrayContaining(['good.v.test']))
    expect(a.zones.getRRsets('v.test').map((s) => s.name)).not.toContain('bad.v.test')
    expect(answers(a, 'good.v.test', RType.A)).toEqual(['192.0.2.1'])
  })

  it('an older version of something never replaces a newer one, whatever order they arrive in', () => {
    const { a } = trio()
    const t = (ms: number) => formatHlc({ ms, counter: 0, node: 'x' })
    const zone = (hlc: string, account: string | null) => entity({ hlc, payload: canonical({ kind: 'native', masters: [], account }) })
    a.users.createAccount('one', '')
    a.cluster.merge('x', [zone(t(1_800_000_000_500), 'one')])
    a.cluster.merge('x', [zone(t(1_800_000_000_100), null)]) // older: must lose
    expect(a.store.get(key.zone('evil.test'))!.hlc).toBe(t(1_800_000_000_500))
    expect(a.zones.getZone('evil.test').accountId).toBe(a.users.listAccounts()[0]!.id)
  })
})

describe('restarts and backups', () => {
  it('keeps its clock moving forward and remembers what it already pulled, after a restart', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    await net.sync()
    const newestStored = b.db.prepare('SELECT MAX(hlc) AS h FROM cluster_entities').get() as { h: string }
    const watermark = b.store.peer('ns1')!.lastSeq
    expect(watermark).toBeGreaterThan(0)
    // a "restart": a new service on the same database, with its wall clock set back
    const { ClusterService } = await import('../src/cluster/cluster.service.js')
    const reborn = new ClusterService(b.db, b.store, b.zones, net.transportFor('ns2'), { nodeId: 'ns2', peers: [{ url: 'mem://ns1', host: 'ns1', label: 'ns1' }], syncSeconds: 3600, now: () => b.t - 1_000_000 })
    expect(reborn.clock.tick() > newestStored.h).toBe(true) // new stamps are later than everything already stored
    net.calls = []
    await reborn.syncAll()
    expect(net.calls[0]!.since).toBe(watermark)
  })

  it('a peer restored from an old backup makes us start over rather than miss its history', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    a.zones.setRRset('z.test', 'w.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync()
    b.store.recordPeer('ns1', { lastSeq: 10_000 }) // we believe we had far more from ns1 than it now has
    net.calls = []
    const r = await b.cluster.pullFrom({ url: 'mem://ns1', host: 'ns1', label: 'ns1' })
    expect(r.ok).toBe(true)
    expect(net.calls.map((c) => c.since)).toEqual([10_000, 0])
    expect(answers(b, 'w.z.test', RType.A)).toEqual(['192.0.2.1'])
  })

  it('two nodes with the same id are detected, not silently merged', async () => {
    const net = new Net()
    const a = net.node('dup', ['elsewhere'])
    net.nodes.set('elsewhere', new TestNode('dup', net, [], {})) // a different machine that was given the same CLUSTER_NODE_ID
    const r = await a.cluster.pullFrom({ url: 'mem://elsewhere', host: 'elsewhere', label: 'elsewhere' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('CLUSTER_NODE_ID') })
  })
})

describe('adopting existing data', () => {
  it('a node that already had zones before joining shares them with the cluster', async () => {
    const net = new Net()
    const a = net.node('ns1', ['ns2'])
    mkZone(a, 'old.test', ['ns1.old.test'])
    a.zones.setRRset('old.test', 'www.old.test', 'A', 300, rec('192.0.2.1'))
    const b = net.node('ns2', ['ns1'])
    a.cluster.capture({ small: true, zones: 'all' }) // what start() does on first boot
    await net.sync()
    expect(answers(b, 'www.old.test', RType.A)).toEqual(['192.0.2.1'])
    expect(allConverged([a, b])).toBe(true)
  })

  it('snapshots are canonical: the same data always gives the same hash, whatever order it was created in', () => {
    const { a, b } = trio()
    for (const [n, order] of [[a, ['x', 'y']], [b, ['y', 'x']]] as const) {
      mkZone(n)
      for (const h of order) n.zones.setRRset('z.test', `${h}.z.test`, 'A', 60, rec(`10.0.0.${h === 'x' ? 1 : 2}`, `10.0.0.${h === 'x' ? 3 : 4}`))
    }
    const hashes = (n: TestNode) => [...buildSnapshot(n.db, { small: true, zones: 'all' }).values()].map((e) => `${e.key}=${e.hash}`).sort()
    expect(hashes(a)).toEqual(hashes(b))
    expect(hashOf(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }))).toBe(hashOf('{"a":[2,{"c":2,"d":1}],"b":1}'))
  })
})

describe('guard rails still apply on every node', () => {
  it('replication does not bypass validation: a conflicting local rule still wins locally', async () => {
    const { net, a, b } = trio()
    mkZone(a)
    await net.sync()
    expect(() => b.zones.setRRset('z.test', 'z.test', 'CNAME', 60, rec('other.test'))).toThrow()
    a.zones.setRRset('z.test', 'x.z.test', 'A', 60, rec('192.0.2.1'))
    await net.sync()
    expect(() => b.zones.setRRset('z.test', 'x.z.test', 'CNAME', 60, rec('y.z.test'))).toThrow(/CNAME/)
    expect(() => a.zones.createZone({ name: 'z.test', nameservers: ['n.z.test'] })).toThrow(ConflictError)
  })
})
