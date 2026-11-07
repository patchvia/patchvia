import { describe, expect, it } from 'vitest'
import { EnvelopeError, deriveKey, open, seal } from '../src/cluster/envelope.js'
import { HlcClock, compareHlc, formatHlc, parseHlc } from '../src/cluster/hlc.js'
import { parsePeerAddress } from '../src/cluster/peer-address.js'
import { loadConfig } from '../src/config/config.js'

describe('HLC', () => {
  it('formats so that string order is time order, with the node id as the tiebreak', () => {
    const a = formatHlc({ ms: 1000, counter: 0, node: 'ns1' })
    const b = formatHlc({ ms: 1000, counter: 1, node: 'ns1' })
    const c = formatHlc({ ms: 1001, counter: 0, node: 'ns1' })
    const d = formatHlc({ ms: 1000, counter: 0, node: 'ns2' })
    expect([c, b, d, a].sort()).toEqual([a, d, b, c])
    expect(compareHlc(c, b)).toBeGreaterThan(0)
    expect(compareHlc(d, a)).toBeGreaterThan(0) // same instant: ns2 wins everywhere
    expect(compareHlc(a, a)).toBe(0)
    expect(formatHlc({ ms: 0xfffffffffff, counter: 0xffff, node: 'n' })).toBe('0fffffffffff.ffff.n')
  })

  it('round-trips and rejects malformed stamps', () => {
    const s = { ms: 1_700_000_000_000, counter: 42, node: 'ns-1.dc2' }
    expect(parseHlc(formatHlc(s))).toEqual(s)
    for (const bad of ['', 'x', '1.2.3', '000000000000.0000.', '000000000000.0000.UPPER']) expect(parseHlc(bad)).toBeUndefined()
  })

  it('never goes backwards: same millisecond bumps the counter, a clock set back keeps the last time', () => {
    let wall = 5000
    const c = new HlcClock('n1', () => wall)
    const a = c.tick()
    const b = c.tick()
    expect(compareHlc(b, a)).toBeGreaterThan(0)
    wall = 100 // clock jumps back (NTP step, VM restore)
    const d = c.tick()
    expect(compareHlc(d, b)).toBeGreaterThan(0)
    wall = 9000
    expect(parseHlc(c.tick())!.ms).toBe(9000)
  })

  it('observing a remote stamp makes the next local stamp later than it (causality across nodes)', () => {
    const a = new HlcClock('a', () => 1000)
    const b = new HlcClock('b', () => 1000)
    const fromA = a.tick()
    b.observe(fromA)
    expect(compareHlc(b.tick(), fromA)).toBeGreaterThan(0)
    // a remote with a clock far ahead drags us forward, never backwards
    const ahead = formatHlc({ ms: 900_000, counter: 7, node: 'z' })
    b.observe(ahead)
    expect(compareHlc(b.tick(), ahead)).toBeGreaterThan(0)
  })

  it('counter overflow borrows a millisecond instead of wrapping', () => {
    const c = new HlcClock('n', () => 1000)
    let prev = c.tick()
    for (let i = 0; i < 70_000; i++) {
      const next = c.tick()
      expect(compareHlc(next, prev)).toBeGreaterThan(0)
      prev = next
    }
  })

  it('resumes after a restart so stamps stay ahead of those issued before it', () => {
    const before = new HlcClock('n', () => 50_000)
    before.tick()
    before.tick()
    const last = before.last()
    const after = new HlcClock('n', () => 1000, last) // clock is now behind what we issued
    expect(compareHlc(after.tick(), last)).toBeGreaterThan(0)
  })

  it('flags stamps from a node whose clock is wildly wrong', () => {
    const c = new HlcClock('n', () => 1_000_000)
    expect(c.isImplausible(formatHlc({ ms: 1_000_000 + 3600_000, counter: 0, node: 'x' }))).toBe(false)
    expect(c.isImplausible(formatHlc({ ms: 1_000_000 + 48 * 3600_000, counter: 0, node: 'x' }))).toBe(true)
    expect(c.isImplausible('garbage')).toBe(true)
  })
})

describe('sealed envelope', () => {
  const secret = 'a-very-long-cluster-secret-0123456789abcdef'
  // A fake marker, split so the source does not contain the literal the public export checks for
  const payload = { hello: 'world', n: [1, 2, 3], key: '-----BEGIN ' + 'PRIVATE KEY-----' }

  it('round-trips and hides the content', () => {
    const t = seal(secret, 'changes', payload)
    expect(t).not.toContain('PRIVATE')
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toContain('hello')
    expect(open(secret, 'changes', t)).toEqual(payload)
  })

  it('is different every time (random nonce) but always opens', () => {
    expect(seal(secret, 'x', payload)).not.toBe(seal(secret, 'x', payload))
  })

  it('rejects the wrong secret, another purpose, tampering and junk, all with the same vague error', () => {
    const t = seal(secret, 'changes', payload)
    const tampered = Buffer.from(t, 'base64url')
    tampered[40] = tampered[40]! ^ 1
    for (const attempt of [
      () => open('another-secret-another-secret-another!', 'changes', t),
      () => open(secret, 'hello', t),
      () => open(secret, 'changes', tampered.toString('base64url')),
      () => open(secret, 'changes', 'not-a-token'),
      () => open(secret, 'changes', ''),
    ]) {
      expect(attempt).toThrow(EnvelopeError)
      expect(attempt).toThrow('invalid cluster message')
    }
  })

  it('rejects stale or future-dated messages so a captured one cannot be replayed later', () => {
    const t = seal(secret, 'changes', payload, 1_000_000)
    expect(open(secret, 'changes', t, 1_000_000 + 4 * 60_000)).toEqual(payload)
    expect(() => open(secret, 'changes', t, 1_000_000 + 6 * 60_000)).toThrow(EnvelopeError)
    expect(() => open(secret, 'changes', t, 1_000_000 - 6 * 60_000)).toThrow(EnvelopeError)
  })

  it('derives different keys per purpose', () => {
    expect(deriveKey(secret, 'envelope').equals(deriveKey(secret, 'jwt'))).toBe(false)
    expect(deriveKey(secret, 'envelope')).toHaveLength(32)
  })
})

describe('peer addresses', () => {
  it.each([
    ['ns2.example.com', 'http://ns2.example.com:8081', 'ns2.example.com:8081'],
    ['203.0.113.5:9000', 'http://203.0.113.5:9000', '203.0.113.5:9000'],
    ['203.0.113.5:80', 'http://203.0.113.5:80', '203.0.113.5:80'],
    ['https://ns3.example.com', 'https://ns3.example.com:443', 'ns3.example.com:443'],
    ['https://ns3.example.com:8443', 'https://ns3.example.com:8443', 'ns3.example.com:8443'],
    ['[2001:db8::1]:8081', 'http://[2001:db8::1]:8081', '[2001:db8::1]:8081'],
  ])('%s', (input, url, label) => {
    const p = parsePeerAddress(input, 8081)
    expect(p.url).toBe(url)
    expect(p.label).toBe(label)
  })
  it.each(['', 'http://', 'host/path', 'user@host', 'host:99999', 'host?x=1'])('rejects %j', (input) => {
    expect(() => parsePeerAddress(input, 8081)).toThrow()
  })
})

describe('cluster configuration', () => {
  const env = (o: Record<string, string>) => loadConfig(o as NodeJS.ProcessEnv)
  const secret = 'x'.repeat(40)
  it('is off by default and on when a secret is set', () => {
    expect(env({}).clusterSecret).toBeUndefined()
    const c = env({ CLUSTER_SECRET: secret, CLUSTER_NODE_ID: 'NS1', CLUSTER_PEERS: 'ns2.x.test, ns3.x.test:9000' })
    expect(c).toMatchObject({ clusterNodeId: 'ns1', clusterPeers: ['ns2.x.test', 'ns3.x.test:9000'], clusterSyncSeconds: 10 })
  })
  it('refuses unsafe or inconsistent settings', () => {
    expect(() => env({ CLUSTER_SECRET: 'short' })).toThrow(/32 characters/)
    expect(() => env({ CLUSTER_PEERS: 'ns2.x.test' })).toThrow(/CLUSTER_SECRET/)
    expect(() => env({ CLUSTER_SECRET: secret, CLUSTER_NODE_ID: 'Bad Name!' })).toThrow(/CLUSTER_NODE_ID/)
    expect(() => env({ CLUSTER_SECRET: secret, CLUSTER_PEERS: 'bad host' })).toThrow(/CLUSTER_PEERS/)
    expect(() => env({ CLUSTER_SECRET: secret, CLUSTER_ALLOW_FROM: 'nope' })).toThrow(/CLUSTER_ALLOW_FROM/)
  })
})
