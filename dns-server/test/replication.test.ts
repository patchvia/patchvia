import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileAcl } from '../src/common/cidr.js'
import { openDatabase } from '../src/db/database.js'
import { decodeMessage } from '../src/dns/decode.js'
import { listenTcp, listenUdp, type Listener } from '../src/dns/listeners.js'
import { ValidationError } from '../src/dns/names.js'
import { RCode, RType } from '../src/dns/types.js'
import { Notifier } from '../src/replication/notifier.js'
import { realIO, type ReplicationIO, type TransferData } from '../src/replication/io.js'
import { SecondaryManager, nextDelaySeconds } from '../src/replication/secondary.js'
import { formatTarget, parseTarget } from '../src/replication/target.js'
import { AuditRepository } from '../src/zones/audit-repository.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ZoneService } from '../src/zones/zone-service.js'
import type { RRsetInput } from '../src/zones/zone.js'
import { ask } from './helpers.js'

const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))
const soa = (serial: number, refresh = 600, retry = 120) => `ns1.p.test hostmaster.p.test ${serial} ${refresh} ${retry} 604800 300`

function node(opts: { onChange?: (z: string) => void } = {}) {
  const db = openDatabase(':memory:')
  const repo = new ZoneRepository(db)
  const index = new ZoneIndex()
  const audit = new AuditRepository(db)
  const svc = new ZoneService(repo, index, audit, opts.onChange)
  return { db, repo, index, audit, svc }
}

function transferOf(serial: number, extra: RRsetInput[] = [], skipped: Record<string, number> = {}): TransferData {
  return {
    serial,
    skipped,
    rrsets: [
      { name: 'p.test', type: 'SOA', ttl: 3600, contents: [soa(serial)] },
      { name: 'p.test', type: 'NS', ttl: 3600, contents: ['ns1.p.test'] },
      { name: 'ns1.p.test', type: 'A', ttl: 3600, contents: ['192.0.2.1'] },
      { name: 'www.p.test', type: 'A', ttl: 300, contents: ['192.0.2.80'] },
      ...extra,
    ],
  }
}

function fakeIO(over: Partial<ReplicationIO> = {}) {
  const calls = { axfr: [] as string[], soa: [] as string[] }
  // Calls are always counted, whatever behaviour a test substitutes
  const io: ReplicationIO = {
    soaSerial: async (t, z) => (calls.soa.push(t.host), over.soaSerial ? over.soaSerial(t, z) : 2026101502),
    axfr: async (t, z) => (calls.axfr.push(t.host), over.axfr ? over.axfr(t, z) : transferOf(2026101502)),
    sendNotify: over.sendNotify ?? (async () => null),
  }
  return { io, calls }
}

describe('target parsing', () => {
  it.each([
    ['ns1.example.net', 'ns1.example.net', 53],
    ['192.0.2.1:5353', '192.0.2.1', 5353],
    ['[2001:db8::1]:5353', '2001:db8::1', 5353],
    ['2001:db8::1', '2001:db8::1', 53],
    ['NS.Example.net.', 'NS.Example.net', 53],
  ])('%s', (input, host, port) => {
    expect(parseTarget(input)).toEqual({ host, port })
  })
  it.each(['', 'bad host', 'a:b', 'host:0', 'host:70000', '[nope]:53', 'a..b'])('rejects %j', (input) => {
    expect(() => parseTarget(input)).toThrow(ValidationError)
  })
  it('formats IPv6 with brackets', () => {
    expect(formatTarget({ host: '::1', port: 53 })).toBe('[::1]:53')
    expect(formatTarget({ host: 'a.b', port: 5 })).toBe('a.b:5')
  })
})

describe('refresh timing', () => {
  it('uses SOA refresh on success and retry on failure, clamped', () => {
    expect(nextDelaySeconds(soa(1, 900, 100), true)).toBe(900)
    expect(nextDelaySeconds(soa(1, 900, 100), false)).toBe(100)
    expect(nextDelaySeconds(soa(1, 5, 5), true)).toBe(30)
    expect(nextDelaySeconds(soa(1, 10 ** 9, 5), true)).toBe(86_400)
    expect(nextDelaySeconds(undefined, true)).toBe(3600)
    expect(nextDelaySeconds(undefined, false)).toBe(120)
  })
})

describe('secondary zones', () => {
  it('require primaries, validate them, and are read-only', () => {
    const { svc } = node()
    expect(() => svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [] })).toThrow(/at least one primary/)
    expect(() => svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['bad host'] })).toThrow(ValidationError)
    svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1', ' ns.other.net:5353 '] })
    expect(svc.getZone('p.test')).toMatchObject({ kind: 'slave', masters: ['192.0.2.1', 'ns.other.net:5353'], serial: 0, recordCount: 0 })
    expect(() => svc.setRRset('p.test', 'x.p.test', 'A', 60, rec('1.1.1.1'))).toThrow(/secondary zone/)
    expect(() => svc.replaceContents('p.test', [])).toThrow(/secondary zone/)
  })

  it('a not-yet-transferred secondary is pending, not a load failure, and serves nothing', () => {
    const { svc, index } = node()
    svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    const fresh = node()
    // simulate a restart with the same database
    const reload = new ZoneService(new ZoneRepository(svc['repo']['db']), fresh.index)
    expect(reload.loadAll()).toEqual({ loaded: 0, failed: [] })
    expect(ask(index, 'p.test', RType.A).rcode).toBe(RCode.REFUSED)
  })

  it('setMasters only applies to secondaries', () => {
    const { svc } = node()
    svc.createZone({ name: 'n.test', nameservers: ['ns.n.test'] })
    expect(() => svc.setMasters('n.test', ['192.0.2.1'])).toThrow(/only secondary/)
    svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    expect(svc.setMasters('p.test', ['192.0.2.9']).masters).toEqual(['192.0.2.9'])
  })
})

describe('promoting a secondary', () => {
  it('keeps its data, becomes editable, stops transferring and keeps serials moving forward', async () => {
    const { io, calls } = fakeIO()
    const n = node()
    n.svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    const mgr = new SecondaryManager(n.repo, n.svc, n.index, io)
    await mgr.retrieve('p.test')
    const before = n.index.get('p.test')!.serial
    expect(() => n.svc.promote('missing.test')).toThrow(/not found/)

    const row = n.svc.promote('p.test', { actor: 'alice' })
    expect(row).toMatchObject({ kind: 'master', masters: [] })
    expect(ask(n.index, 'www.p.test', RType.A).answers).toHaveLength(1) // still served
    n.svc.setRRset('p.test', 'new.p.test', 'A', 60, rec('1.2.3.4')) // now editable
    expect(n.index.get('p.test')!.serial).toBeGreaterThan(before)
    await expect(mgr.retrieve('p.test')).rejects.toThrow(/not a secondary/) // no longer transfers
    expect(calls.axfr).toHaveLength(1)
    expect(n.audit.list({ zone: 'p.test' }).find((e) => e.action === 'zone.promote')).toMatchObject({ actor: 'alice' })
  })

  it('refuses zones that are not secondaries or have not transferred yet', () => {
    const n = node()
    n.svc.createZone({ name: 'n.test', nameservers: ['ns.n.test'] })
    expect(() => n.svc.promote('n.test')).toThrow(/only secondary/)
    n.svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    expect(() => n.svc.promote('p.test')).toThrow(/first transfer/)
  })
})

describe('SecondaryManager', () => {
  function setup(io: ReplicationIO, now = () => 1_000_000) {
    const n = node()
    n.svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: ['192.0.2.1'] })
    const mgr = new SecondaryManager(n.repo, n.svc, n.index, io, now)
    return { ...n, mgr }
  }

  it('retrieve loads the zone, serves it, records the transfer and audits it', async () => {
    const { io, calls } = fakeIO({ axfr: async () => transferOf(2026101502, [], { DNSKEY: 2, RRSIG: 5 }) })
    const { mgr, index, svc, audit } = setup(io)
    const res = await mgr.retrieve('p.test')
    expect(res).toMatchObject({ updated: true, serial: 2026101502, records: 3 })
    expect(ask(index, 'www.p.test', RType.A).answers[0]!.text).toBe('192.0.2.80')
    expect(svc.getZone('p.test')).toMatchObject({ serial: 2026101502, transferError: null })
    expect(svc.getZone('p.test').lastTransfer).toBeTruthy()
    const entry = audit.list({ zone: 'p.test' }).find((e) => e.action === 'zone.transfer')!
    expect(entry.actor).toBe('transfer')
    expect(entry.detail).toMatchObject({ serial: 2026101502, records: 3, skipped: { DNSKEY: 2, RRSIG: 5 } })
    expect(calls.axfr).toEqual(['192.0.2.1'])
  })

  it('check skips the transfer when the primary is not newer, and transfers when it is', async () => {
    let remote = 2026101502
    const { io, calls } = fakeIO({
      soaSerial: async () => remote,
      axfr: async () => transferOf(remote, [{ name: `v${remote}.p.test`, type: 'A', ttl: 60, contents: ['10.0.0.1'] }]),
    })
    const { mgr, index } = setup(io)
    await mgr.retrieve('p.test')
    expect(calls.axfr).toHaveLength(1)
    expect(await mgr.check('p.test')).toMatchObject({ updated: false, serial: 2026101502 })
    expect(calls.axfr).toHaveLength(1)
    remote = 2026101503
    expect(await mgr.check('p.test')).toMatchObject({ updated: true, serial: 2026101503 })
    expect(ask(index, 'v2026101503.p.test', RType.A).answers).toHaveLength(1)
    expect(ask(index, 'v2026101502.p.test', RType.A).rcode).toBe(RCode.NXDOMAIN) // replaced, not merged
  })

  it('records a failure, keeps serving the old data, and reports every primary tried', async () => {
    let fail = false
    const { io } = fakeIO({
      axfr: async (t) => {
        if (fail) throw new Error(t.host === '192.0.2.1' ? 'connection refused' : 'timed out')
        return transferOf(2026101502)
      },
    })
    const { mgr, svc, index, repo } = setup(io)
    await mgr.retrieve('p.test')
    repo.setMasters(repo.getZone('p.test')!.id, ['192.0.2.1', '192.0.2.2'])
    fail = true
    await expect(mgr.retrieve('p.test')).rejects.toThrow(/192\.0\.2\.1: connection refused; 192\.0\.2\.2: timed out/)
    expect(svc.getZone('p.test').transferError).toMatch(/connection refused/)
    expect(ask(index, 'www.p.test', RType.A).answers).toHaveLength(1) // stale data still served
    fail = false
    await mgr.retrieve('p.test')
    expect(svc.getZone('p.test').transferError).toBeNull()
  })

  it('falls through to the next primary', async () => {
    const { io, calls } = fakeIO({
      axfr: async (t) => {
        if (t.host === '192.0.2.1') throw new Error('down')
        return transferOf(2026101502)
      },
    })
    const { mgr, repo } = setup(io)
    repo.setMasters(repo.getZone('p.test')!.id, ['192.0.2.1', '192.0.2.2'])
    await mgr.retrieve('p.test')
    expect(calls.axfr).toEqual(['192.0.2.1', '192.0.2.2'])
  })

  it('skips records that do not validate instead of failing the transfer, and rejects a transfer without SOA', async () => {
    const bad: RRsetInput[] = [
      { name: 'bad name.p.test', type: 'A', ttl: 60, contents: ['1.1.1.1'] },
      { name: 'other.example', type: 'A', ttl: 60, contents: ['1.1.1.1'] },
    ]
    const { io } = fakeIO({ axfr: async () => transferOf(2026101502, bad) })
    const { mgr, audit, index } = setup(io)
    await mgr.retrieve('p.test')
    const entry = audit.list({ zone: 'p.test' }).find((e) => e.action === 'zone.transfer')!
    expect((entry.detail as { invalidCount: number }).invalidCount).toBe(2)
    expect(index.get('p.test')!.recordCount).toBe(3)

    const noSoa = fakeIO({ axfr: async () => ({ serial: 1, skipped: {}, rrsets: transferOf(1).rrsets.filter((s) => s.type !== 'SOA') }) })
    const s2 = setup(noSoa.io)
    await expect(s2.mgr.retrieve('p.test')).rejects.toThrow(/no SOA/)
    expect(s2.index.get('p.test')).toBeUndefined()
  })

  it('refuses non-secondary zones', async () => {
    const { io } = fakeIO()
    const { mgr, svc } = setup(io)
    svc.createZone({ name: 'n.test', nameservers: ['ns.n.test'] })
    await expect(mgr.retrieve('n.test')).rejects.toThrow(/not a secondary/)
  })

  it('shares one in-flight transfer between concurrent callers', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { io, calls } = fakeIO({ axfr: async () => (await gate, transferOf(2026101502)) })
    const { mgr } = setup(io)
    const a = mgr.retrieve('p.test')
    const b = mgr.check('p.test')
    release()
    await Promise.all([a, b])
    expect(calls.axfr).toHaveLength(1)
  })

  it('schedules the next refresh from the SOA and only ticks when due', async () => {
    let t = 1_000_000
    const { io, calls } = fakeIO()
    const { mgr } = setup(io, () => t)
    await mgr.retrieve('p.test') // refresh 600s
    await mgr.tick()
    expect(calls.soa).toHaveLength(0) // not due yet
    t += 599_000
    await mgr.tick()
    expect(calls.soa).toHaveLength(0)
    t += 2_000
    await mgr.tick()
    expect(calls.soa).toHaveLength(1)
  })

  describe('incoming NOTIFY', () => {
    it('is not authoritative for unknown or non-secondary zones', () => {
      const { mgr, svc } = setup(fakeIO().io)
      svc.createZone({ name: 'n.test', nameservers: ['ns.n.test'] })
      expect(mgr.handleNotify('n.test', '192.0.2.1')).toBe(RCode.NOTAUTH)
      expect(mgr.handleNotify('nope.test', '192.0.2.1')).toBe(RCode.NOTAUTH)
    })
    it('refuses strangers, accepts the primary (also IPv4-mapped) and triggers a check', async () => {
      const { io, calls } = fakeIO()
      const { mgr } = setup(io)
      expect(mgr.handleNotify('p.test', '198.51.100.9')).toBe(RCode.REFUSED)
      expect(mgr.handleNotify('p.test', undefined)).toBe(RCode.REFUSED)
      expect(mgr.handleNotify('p.test', '::ffff:192.0.2.1')).toBe(RCode.NOERROR)
      await vi.waitFor(() => expect(calls.axfr).toHaveLength(1)) // first contact transfers, no local serial yet
    })
  })
})

describe('Notifier', () => {
  const target = { host: '192.0.2.50', port: 53 }
  const ackFor = async (sent: Buffer) => {
    const reply = Buffer.from(sent)
    reply[2] = reply[2]! | 0x80 // QR
    return reply
  }

  afterEach(() => vi.useRealTimers())

  it('coalesces a burst of changes into one NOTIFY per target', async () => {
    const sent: Buffer[] = []
    const n = new Notifier([target], { sendNotify: async (_t, p) => (sent.push(p), ackFor(p)) }, { debounceMs: 20 })
    for (let i = 0; i < 10; i++) n.schedule('p.test')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 60))
    expect(sent).toHaveLength(1)
    const m = decodeMessage(sent[0]!)
    expect(m).toMatchObject({ opcode: 4, aa: true })
    expect(m.questions[0]).toMatchObject({ name: 'p.test', type: RType.SOA })
  })

  it('retries when nobody answers and then gives up', async () => {
    let attempts = 0
    const n = new Notifier([target], { sendNotify: async () => (attempts++, null) }, { debounceMs: 1, retryDelaysMs: [5, 5], timeoutMs: 5 })
    n.schedule('p.test')
    await vi.waitFor(() => expect(attempts).toBe(3))
    await new Promise((r) => setTimeout(r, 40))
    expect(attempts).toBe(3)
  })

  it('does not retry when the secondary rejects it', async () => {
    let attempts = 0
    const io = {
      sendNotify: async (_t: unknown, p: Buffer) => {
        attempts++
        const reply = await ackFor(p)
        reply[3] = (reply[3]! & 0xf0) | RCode.REFUSED
        return reply
      },
    }
    const n = new Notifier([target], io, { debounceMs: 1, retryDelaysMs: [5, 5] })
    n.schedule('p.test')
    await vi.waitFor(() => expect(attempts).toBe(1))
    await new Promise((r) => setTimeout(r, 40))
    expect(attempts).toBe(1)
  })

  it('notifyNow reports which targets acknowledged; ignores replies with the wrong id', async () => {
    const t2 = { host: '192.0.2.51', port: 5353 }
    const io = {
      sendNotify: async (t: { host: string }, p: Buffer) => {
        if (t.host === '192.0.2.50') return ackFor(p)
        const wrong = await ackFor(p)
        wrong[1] = wrong[1]! ^ 0xff
        return wrong
      },
    }
    const n = new Notifier([target, t2], io, {})
    expect(await n.notifyNow('p.test')).toEqual([
      { target: '192.0.2.50:53', acked: true },
      { target: '192.0.2.51:5353', acked: false },
    ])
  })

  it('does nothing without targets', () => {
    const io = { sendNotify: vi.fn() }
    new Notifier([], io).schedule('p.test')
    expect(io.sendNotify).not.toHaveBeenCalled()
  })
})

describe('end to end over real sockets', () => {
  const closers: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c()
  })

  it('a secondary pulls from a primary, follows changes via NOTIFY, and the primary refuses strangers', async () => {
    // --- secondary: UDP listener for NOTIFY first, so the primary knows where to send it
    const sec = node()
    const mgr = new SecondaryManager(sec.repo, sec.svc, sec.index, realIO)
    const secUdp: Listener = await listenUdp(sec.index, '127.0.0.1', 0, { notify: (z, r) => mgr.handleNotify(z, r) })
    closers.push(() => secUdp.close())

    // --- primary: transfers allowed from loopback, NOTIFY to the secondary on every change
    const notifier = new Notifier([{ host: '127.0.0.1', port: secUdp.port }], realIO, { debounceMs: 20 })
    const pri = node({ onChange: (z) => notifier.schedule(z) })
    const transfers = {
      allow: compileAcl(['127.0.0.1']),
      zone: (name: string) => (pri.index.get(name)?.apex === name ? pri.index.get(name) : undefined),
    }
    const priTcp = await listenTcp(pri.index, '127.0.0.1', 0, { transfers })
    closers.push(() => priTcp.close(), () => notifier.stop())

    pri.svc.createZone({ name: 'p.test', nameservers: ['ns1.p.test'], hostmaster: 'hostmaster.p.test' })
    const many = Array.from({ length: 1200 }, (_, i) => ({
      name: `h${i}.p.test`,
      type: 'A' as const,
      changetype: 'REPLACE' as const,
      ttl: 60,
      records: rec(`10.${i >> 8}.${i & 255}.1`),
    }))
    pri.svc.applyChanges('p.test', [...many, { name: 'txt.p.test', type: 'TXT', changetype: 'REPLACE', ttl: 60, records: rec('"hello \\"world\\""') }])
    pri.svc.setRRset('p.test', 'p.test', 'MX', 300, rec('10 mail.p.test'))

    sec.svc.createZone({ name: 'p.test', kind: 'slave', nameservers: [], masters: [`127.0.0.1:${priTcp.port}`] })

    // initial transfer
    const first = await mgr.retrieve('p.test')
    expect(first).toMatchObject({ updated: true, records: 1203 }) // 1200 hosts + NS + MX + TXT
    expect(ask(sec.index, 'h777.p.test', RType.A).answers[0]!.text).toBe('10.3.9.1')
    expect(ask(sec.index, 'txt.p.test', RType.TXT).answers[0]!.text).toBe('hello "world"')
    expect(sec.index.get('p.test')!.serial).toBe(pri.index.get('p.test')!.serial)
    expect(sec.index.get('p.test')!.recordCount).toBe(pri.index.get('p.test')!.recordCount)

    // a change on the primary reaches the secondary through a real NOTIFY, without waiting for any timer
    const before = sec.index.get('p.test')!.serial
    pri.svc.setRRset('p.test', 'new.p.test', 'A', 60, rec('203.0.113.77'))
    await vi.waitFor(() => expect(ask(sec.index, 'new.p.test', RType.A).answers).toHaveLength(1), { timeout: 5000 })
    expect(sec.index.get('p.test')!.serial).toBeGreaterThan(before)
    expect(sec.svc.getZone('p.test').transferError).toBeNull()

    // an up-to-date secondary does not transfer again
    expect(await mgr.check('p.test')).toMatchObject({ updated: false })

    // a client that is not on the allow-list is refused
    const stranger = { allow: compileAcl(['198.51.100.1']), zone: transfers.zone }
    const closedTcp = await listenTcp(pri.index, '127.0.0.1', 0, { transfers: stranger })
    closers.push(() => closedTcp.close())
    sec.repo.setMasters(sec.repo.getZone('p.test')!.id, [`127.0.0.1:${closedTcp.port}`])
    await expect(mgr.retrieve('p.test')).rejects.toThrow(/refused/)
    expect(sec.svc.getZone('p.test').transferError).toMatch(/refused/)
    expect(ask(sec.index, 'h1.p.test', RType.A).answers).toHaveLength(1) // keeps serving what it had
  })
})
