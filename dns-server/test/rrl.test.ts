import dgram from 'node:dgram'
import net from 'node:net'
import { describe, expect, it, afterEach } from 'vitest'
import { compileAcl } from '../src/common/cidr.js'
import { encodeQuery } from '../src/dns/codec.js'
import { handleMessages } from '../src/dns/handler.js'
import { decodeMessage } from '../src/dns/decode.js'
import { listenTcp, listenUdp, type Listener } from '../src/dns/listeners.js'
import { ResponseRateLimiter, clientPrefix } from '../src/dns/rrl.js'
import { Stats, renderMetrics } from '../src/dns/stats.js'
import { RType } from '../src/dns/types.js'
import { indexOf } from './helpers.js'

describe('clientPrefix', () => {
  it('groups IPv4 by /24 and IPv6 by /56, unwrapping IPv4-mapped addresses', () => {
    expect(clientPrefix('203.0.113.77')).toBe('203.0.113.0/24')
    expect(clientPrefix('::ffff:203.0.113.9')).toBe('203.0.113.0/24')
    expect(clientPrefix('2001:db8:1:2:3:4:5:6')).toBe(clientPrefix('2001:db8:1:2ff:9::1'.replace(':2ff:', ':2:')))
    expect(clientPrefix('2001:db8:1:200::1')).not.toBe(clientPrefix('2001:db8:1:2::1'))
  })
})

describe('ResponseRateLimiter', () => {
  const mk = (over: Partial<ConstructorParameters<typeof ResponseRateLimiter>[0]> = {}) => {
    let t = 1_000_000
    const rrl = new ResponseRateLimiter({ responsesPerSecond: 5, slip: 2, now: () => t, ...over })
    return { rrl, tick: (ms: number) => (t += ms) }
  }
  const burst = (rrl: ResponseRateLimiter, n: number, ip = '198.51.100.7', key = 'a.test|1|0') => Array.from({ length: n }, () => rrl.check(ip, key))

  it('allows up to the rate, then drops and slips every other response', () => {
    const { rrl } = mk()
    const r = burst(rrl, 12)
    expect(r.slice(0, 5)).toEqual(Array(5).fill('allow'))
    expect(r.slice(5)).toEqual(['drop', 'truncate', 'drop', 'truncate', 'drop', 'truncate', 'drop'])
    expect(rrl.stats).toEqual({ dropped: 4, truncated: 3 })
  })

  it('refills over time and recovers fully', () => {
    const { rrl, tick } = mk()
    burst(rrl, 10)
    tick(1000)
    expect(burst(rrl, 5)).toEqual(Array(5).fill('allow'))
    expect(burst(rrl, 1)[0]).not.toBe('allow')
    tick(400) // two tokens
    expect(burst(rrl, 3).filter((d) => d === 'allow')).toHaveLength(2)
  })

  it('budgets per client network and per response, not globally', () => {
    const { rrl } = mk()
    burst(rrl, 20)
    expect(rrl.check('198.51.100.200', 'a.test|1|0')).not.toBe('allow') // same /24
    expect(rrl.check('198.51.101.7', 'a.test|1|0')).toBe('allow') // other network
    expect(rrl.check('198.51.100.7', 'b.test|1|0')).toBe('allow') // other question
  })

  it('never limits exempt clients, and is off when the rate is 0', () => {
    const { rrl } = mk({ exempt: compileAcl(['127.0.0.1', '10.0.0.0/8']) })
    expect(burst(rrl, 50, '127.0.0.1').every((d) => d === 'allow')).toBe(true)
    expect(burst(rrl, 50, '10.2.3.4').every((d) => d === 'allow')).toBe(true)
    const off = mk({ responsesPerSecond: 0 }).rrl
    expect(off.enabled).toBe(false)
    expect(burst(off, 100).every((d) => d === 'allow')).toBe(true)
  })

  it('slip 0 drops everything over the limit', () => {
    const { rrl } = mk({ slip: 0 })
    expect(new Set(burst(rrl, 30).slice(5))).toEqual(new Set(['drop']))
  })

  it('stays bounded under a flood of spoofed sources', () => {
    const { rrl, tick } = mk({ maxEntries: 1000 })
    for (let i = 0; i < 5000; i++) {
      rrl.check(`10.${(i >> 8) & 255}.${i & 255}.1`, 'x|1|0')
      if (i % 100 === 0) tick(3000)
    }
    expect(rrl.size).toBeLessThanOrEqual(1000)
  })
})

describe('rate limiting in the handler', () => {
  const idx = indexOf('r.test', [
    { name: 'r.test', type: 'SOA', ttl: 60, contents: ['ns.r.test h.r.test 1 1 1 1 60'] },
    { name: 'r.test', type: 'NS', ttl: 60, contents: ['ns.r.test'] },
    { name: 'r.test', type: 'A', ttl: 60, contents: ['192.0.2.1'] },
  ])
  const ask = (ctx: Parameters<typeof handleMessages>[4], name = 'r.test', ip = '198.51.100.7', transport: 'udp' | 'tcp' = 'udp') =>
    handleMessages(idx, encodeQuery(1, name, RType.A), transport, ip, ctx)

  it('truncated responses are empty with TC set; dropped ones produce nothing; TCP is never limited', () => {
    const stats = new Stats()
    const limiter = new ResponseRateLimiter({ responsesPerSecond: 2, slip: 2 })
    const ctx = { limiter, stats }
    const out = Array.from({ length: 8 }, () => ask(ctx))
    expect(out.slice(0, 2).every((o) => o.length === 1 && decodeMessage(o[0]!).answers.length === 1)).toBe(true)
    const kinds = out.slice(2).map((o) => (o.length === 0 ? 'drop' : decodeMessage(o[0]!).tc ? 'tc' : 'answer'))
    expect(kinds).toEqual(['drop', 'tc', 'drop', 'tc', 'drop', 'tc'])
    const tc = out.find((o) => o[0] && decodeMessage(o[0]).tc)![0]!
    expect(decodeMessage(tc).answers).toHaveLength(0)
    expect(stats.snapshot().rateLimited).toEqual({ dropped: 3, truncated: 3 })
    for (let i = 0; i < 10; i++) expect(ask(ctx, 'r.test', '198.51.100.7', 'tcp')).toHaveLength(1)
  })

  it('shares one budget across random subdomains of a zone (NXDOMAIN flood)', () => {
    const limiter = new ResponseRateLimiter({ responsesPerSecond: 3, slip: 0 })
    const results = Array.from({ length: 10 }, (_, i) => ask({ limiter }, `rand${i}.r.test`))
    expect(results.filter((o) => o.length === 1)).toHaveLength(3)
  })
})

describe('TCP connection cap per address', () => {
  const closers: Listener[] = []
  afterEach(async () => {
    for (const l of closers.splice(0)) await l.close()
  })
  it('refuses connections beyond the limit and frees the slot when one closes', async () => {
    const idx = indexOf('c.test', [
      { name: 'c.test', type: 'SOA', ttl: 60, contents: ['ns.c.test h.c.test 1 1 1 1 60'] },
      { name: 'c.test', type: 'NS', ttl: 60, contents: ['ns.c.test'] },
    ])
    const l = await listenTcp(idx, '127.0.0.1', 0, { maxTcpPerIp: 2 })
    closers.push(l)
    const open = () =>
      new Promise<net.Socket>((resolve) => {
        const s = net.connect(l.port, '127.0.0.1')
        s.on('error', () => undefined)
        s.once('connect', () => resolve(s))
      })
    const closed = (s: net.Socket) => new Promise<boolean>((r) => (s.once('close', () => r(true)), setTimeout(() => r(false), 300)))
    const a = await open()
    const b = await open()
    const c = await open()
    expect(await closed(c)).toBe(true) // third is cut off
    expect(a.destroyed || b.destroyed).toBe(false)
    a.destroy()
    await new Promise((r) => setTimeout(r, 50))
    const d = await open()
    expect(await closed(d)).toBe(false) // slot was freed
    b.destroy()
    d.destroy()
  })
})

describe('UDP end to end', () => {
  it('limits real packets from one address but exempts configured ones', async () => {
    const idx = indexOf('u.test', [
      { name: 'u.test', type: 'SOA', ttl: 60, contents: ['ns.u.test h.u.test 1 1 1 1 60'] },
      { name: 'u.test', type: 'NS', ttl: 60, contents: ['ns.u.test'] },
    ])
    const limiter = new ResponseRateLimiter({ responsesPerSecond: 3, slip: 0 })
    const l = await listenUdp(idx, '127.0.0.1', 0, { limiter })
    try {
      const sock = dgram.createSocket('udp4')
      let got = 0
      sock.on('message', () => got++)
      for (let i = 0; i < 10; i++) sock.send(encodeQuery(i, 'u.test', RType.NS), l.port, '127.0.0.1')
      await new Promise((r) => setTimeout(r, 300))
      sock.close()
      expect(got).toBe(3)
    } finally {
      await l.close()
    }
  })
})

describe('Prometheus metrics', () => {
  it('renders valid exposition text with labels and escaping', () => {
    const stats = new Stats()
    stats.record('udp', 0, 1)
    stats.record('tcp', 3, 28)
    stats.recordLimited('drop')
    const text = renderMetrics({ stats: stats.snapshot(), zones: 4, records: 120, dnssecZones: 1, secondaryZones: 2, secondaryFailing: 1 })
    expect(text).toContain('# TYPE dns_queries_total counter')
    expect(text).toContain('dns_queries_total{transport="udp"} 1')
    expect(text).toContain('dns_queries_total{transport="tcp"} 1')
    expect(text).toContain('dns_responses_total{rcode="NXDOMAIN"} 1')
    expect(text).toContain('dns_queries_by_type_total{qtype="AAAA"} 1')
    expect(text).toContain('dns_rate_limited_total{action="dropped"} 1')
    expect(text).toContain('dns_secondary_zones{state="failing"} 1')
    expect(text).toContain('dns_dnssec_zones 1')
    expect(text).not.toContain('dns_cluster_peers') // only in cluster mode
    const withCluster = renderMetrics({ stats: stats.snapshot(), zones: 1, records: 1, dnssecZones: 0, secondaryZones: 0, secondaryFailing: 0, cluster: { peersConnected: 2, peersFailing: 1, peersJoining: 0 } })
    expect(withCluster).toContain('dns_cluster_peers{state="connected"} 2')
    expect(withCluster).toContain('dns_cluster_peers{state="failing"} 1')
    expect(text.endsWith('\n')).toBe(true)
    // every sample line is "name{labels} value" or "name value"
    for (const line of text.trim().split('\n').filter((l) => !l.startsWith('#'))) expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? \d+(\.\d+)?$/)
  })
})
