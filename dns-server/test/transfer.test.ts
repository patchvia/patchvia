import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileAcl, normalizeIp } from '../src/common/cidr.js'
import { decodeMessage, ipv6ToString, rdataToContent } from '../src/dns/decode.js'
import { encodeNotify, encodeQuery } from '../src/dns/codec.js'
import { handleMessages } from '../src/dns/handler.js'
import { listenTcp, type Listener } from '../src/dns/listeners.js'
import { encodeRdata } from '../src/dns/rdata.js'
import { OpCode, RCode, RType, STORABLE_TYPES, type RTypeName } from '../src/dns/types.js'
import { serialGt } from '../src/zones/serial.js'
import type { TransferPolicy } from '../src/dns/transfer.js'
import type { RRsetInput } from '../src/zones/zone.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { buildZone } from '../src/zones/zone.js'
import { indexOf } from './helpers.js'

const r = (name: string, type: RRsetInput['type'], contents: string[], ttl = 300): RRsetInput => ({ name, type, ttl, contents })

const SOA = 'ns1.x.test hostmaster.x.test 2026101500 10800 3600 604800 300'

function bigZone(records = 3000): RRsetInput[] {
  return [
    r('x.test', 'SOA', [SOA], 3600),
    r('x.test', 'NS', ['ns1.x.test']),
    r('ns1.x.test', 'A', ['192.0.2.1']),
    r('x.test', 'MX', ['10 mail.x.test']),
    ...Array.from({ length: records }, (_, i) => r(`h${i}.x.test`, 'A', [`10.${(i >> 8) & 255}.${i & 255}.1`])),
  ]
}

function policy(index: ZoneIndex, allowed: string[]): TransferPolicy {
  const allow = compileAcl(allowed)
  return { allow, zone: (name) => (index.get(name)?.apex === name ? index.get(name) : undefined) }
}

describe('CIDR ACL', () => {
  it('matches single addresses and networks in both families', () => {
    const acl = compileAcl(['127.0.0.1', '10.1.0.0/16', '2001:db8::/32', '::1'])
    expect(acl('127.0.0.1')).toBe(true)
    expect(acl('10.1.200.3')).toBe(true)
    expect(acl('10.2.0.1')).toBe(false)
    expect(acl('2001:db8:ffff::1')).toBe(true)
    expect(acl('2001:db9::1')).toBe(false)
    expect(acl('::1')).toBe(true)
  })
  it('unwraps IPv4-mapped IPv6 as reported by dual-stack sockets, and rejects garbage', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3')
    expect(compileAcl(['10.0.0.0/8'])('::ffff:10.9.9.9')).toBe(true)
    expect(compileAcl(['10.0.0.0/8'])(undefined)).toBe(false)
    expect(compileAcl([])('127.0.0.1')).toBe(false)
    expect(() => compileAcl(['nope'])).toThrow()
    expect(() => compileAcl(['10.0.0.0/33'])).toThrow()
    expect(() => compileAcl(['10.0.0.0/8/1'])).toThrow()
  })
  it('/0 matches everything of its family', () => {
    expect(compileAcl(['0.0.0.0/0'])('203.0.113.9')).toBe(true)
    expect(compileAcl(['0.0.0.0/0'])('::1')).toBe(false)
  })
})

describe('serial arithmetic', () => {
  it('compares with wraparound', () => {
    expect(serialGt(2, 1)).toBe(true)
    expect(serialGt(1, 2)).toBe(false)
    expect(serialGt(1, 1)).toBe(false)
    expect(serialGt(5, 0xfffffff0)).toBe(true) // wrapped past zero
    expect(serialGt(0xfffffff0, 5)).toBe(false)
  })
})

describe('rdata decoding round-trips encoding', () => {
  const cases: [RTypeName, string][] = [
    ['A', '192.0.2.10'],
    ['AAAA', '2001:db8::10'],
    ['AAAA', '::1'],
    ['AAAA', '2001:db8:0:1:0:0:0:1'],
    ['CNAME', 'target.example.com'],
    ['NS', 'ns1.example.com'],
    ['PTR', 'host.example.com'],
    ['MX', '10 mail.example.com'],
    ['SRV', '10 5 5060 sip.example.com'],
    ['TXT', '"v=spf1 mx -all"'],
    ['TXT', '"has \\"quotes\\" and \\\\ slash"'],
    ['TXT', '"two" "strings"'],
    ['CAA', '0 issue "letsencrypt.org"'],
    ['SOA', SOA],
  ]
  it.each(cases)('%s %s', (type, content) => {
    const wire = encodeRdata(type, content).wire
    const back = rdataToContent(RType[type], wire, 0, wire.length)!
    // Our own encoder accepts what the decoder prints, and produces identical bytes
    expect(encodeRdata(type, back).wire.equals(wire)).toBe(true)
  })
  it('compresses IPv6 per RFC 5952 and keeps UTF-8 TXT readable', () => {
    expect(ipv6ToString(encodeRdata('AAAA', '2001:0db8:0000:0000:0000:0000:0000:0001').wire)).toBe('2001:db8::1')
    expect(ipv6ToString(encodeRdata('AAAA', '1:0:2:0:0:3:0:4').wire)).toBe('1:0:2::3:0:4')
    const wire = encodeRdata('TXT', '"café ✓"').wire
    expect(rdataToContent(RType.TXT, wire, 0, wire.length)).toBe('"café ✓"')
  })
  it('returns null for types it does not serve', () => {
    expect(rdataToContent(48, Buffer.alloc(4), 0, 4)).toBeNull()
  })
  it('every storable type is covered', () => {
    expect(new Set(cases.map(([t]) => t))).toEqual(new Set(STORABLE_TYPES))
  })
})

describe('AXFR / IXFR over the handler', () => {
  const idx = indexOf('x.test', bigZone(3000))
  const open = policy(idx, ['203.0.113.7'])
  const axfr = (remote: string | undefined, type = RType.AXFR, transport: 'tcp' | 'udp' = 'tcp') =>
    handleMessages(idx, encodeQuery(9, 'x.test', type), transport, remote, { transfers: open })

  it('streams SOA, all records, SOA across several messages', () => {
    const msgs = axfr('203.0.113.7').map(decodeMessage)
    expect(msgs.length).toBeGreaterThan(1)
    expect(msgs[0]!.questions).toHaveLength(1)
    expect(msgs[1]!.questions).toHaveLength(0)
    const all = msgs.flatMap((m) => m.answers)
    expect(all[0]!.type).toBe(RType.SOA)
    expect(all.at(-1)!.type).toBe(RType.SOA)
    expect(all.at(-1)!.content).toBe(all[0]!.content)
    expect(all.filter((a) => a.type === RType.SOA)).toHaveLength(2)
    expect(all).toHaveLength(3000 + 4 + 1) // 3000 hosts + NS, ns1, MX + 2 SOAs
    expect(msgs.every((m) => m.rcode === RCode.NOERROR && m.aa)).toBe(true)
  })

  it('refuses clients outside the allow-list, unknown zones, non-apex names, and UDP AXFR', () => {
    expect(decodeMessage(axfr('198.51.100.1')[0]!).rcode).toBe(RCode.REFUSED)
    expect(decodeMessage(axfr(undefined)[0]!).rcode).toBe(RCode.REFUSED)
    expect(decodeMessage(handleMessages(idx, encodeQuery(1, 'other.test', RType.AXFR), 'tcp', '203.0.113.7', { transfers: open })[0]!).rcode).toBe(RCode.REFUSED)
    expect(decodeMessage(handleMessages(idx, encodeQuery(1, 'h1.x.test', RType.AXFR), 'tcp', '203.0.113.7', { transfers: open })[0]!).rcode).toBe(RCode.REFUSED)
    expect(decodeMessage(axfr('203.0.113.7', RType.AXFR, 'udp')[0]!).rcode).toBe(RCode.REFUSED)
  })

  it('refuses everything when no transfer ACL entries exist', () => {
    const closed = policy(idx, [])
    expect(decodeMessage(handleMessages(idx, encodeQuery(1, 'x.test', RType.AXFR), 'tcp', '127.0.0.1', { transfers: closed })[0]!).rcode).toBe(RCode.REFUSED)
  })

  it('answers IXFR from a current client with only the SOA, and falls back to a full transfer when behind', () => {
    const ixfr = (serial: number, transport: 'tcp' | 'udp') => {
      // IXFR request carries the client's SOA in the authority section: build it by hand
      const q = encodeQuery(5, 'x.test', RType.IXFR)
      const soaRdata = encodeRdata('SOA', `ns1.x.test hostmaster.x.test ${serial} 1 1 1 1`).wire
      const rr = Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 6, 0, 1, 0, 0, 0, 0, soaRdata.length >> 8, soaRdata.length & 0xff]), soaRdata])
      q.writeUInt16BE(1, 8) // nscount
      return handleMessages(idx, Buffer.concat([q, rr]), transport, '203.0.113.7', { transfers: open })
    }
    const current = ixfr(2026101500, 'tcp').map(decodeMessage)
    expect(current).toHaveLength(1)
    expect(current[0]!.answers.map((a) => a.type)).toEqual([RType.SOA])
    const behind = ixfr(2026101400, 'tcp').map(decodeMessage)
    expect(behind.flatMap((m) => m.answers).length).toBe(3000 + 4 + 1)
    const udp = ixfr(2026101400, 'udp').map(decodeMessage)
    expect(udp).toHaveLength(1)
    expect(udp[0]!.tc).toBe(true)
  })

  it('does not serve transfers at all when no policy is configured', () => {
    expect(decodeMessage(handleMessages(idx, encodeQuery(1, 'x.test', RType.AXFR), 'tcp', '203.0.113.7')[0]!).rcode).toBe(RCode.REFUSED)
  })
})

describe('NOTIFY handling', () => {
  const idx = indexOf('x.test', bigZone(1))
  it('delegates to the handler and echoes the question with AA on success', () => {
    const seen: [string, string | undefined][] = []
    const out = handleMessages(idx, encodeNotify(77, 'X.Test'), 'udp', '203.0.113.7', {
      notify: (zone, remote) => (seen.push([zone, remote]), RCode.NOERROR),
    })
    const m = decodeMessage(out[0]!)
    expect(seen).toEqual([['x.test', '203.0.113.7']])
    expect(m).toMatchObject({ id: 77, opcode: OpCode.NOTIFY, rcode: RCode.NOERROR, aa: true })
    expect(m.questions[0]).toMatchObject({ name: 'x.test', type: RType.SOA })
  })
  it('passes through a refusal and answers NOTIMP when no handler exists', () => {
    expect(decodeMessage(handleMessages(idx, encodeNotify(1, 'x.test'), 'udp', '1.2.3.4', { notify: () => RCode.REFUSED })[0]!).rcode).toBe(RCode.REFUSED)
    expect(decodeMessage(handleMessages(idx, encodeNotify(1, 'x.test'), 'udp', '1.2.3.4')[0]!).rcode).toBe(RCode.NOTIMP)
  })
})

describe('AXFR over a real TCP socket', () => {
  let listener: Listener
  const idx = new ZoneIndex()
  beforeAll(async () => {
    idx.set(buildZone('x.test', bigZone(2500)))
    listener = await listenTcp(idx, '127.0.0.1', 0, { transfers: policy(idx, ['127.0.0.1']) })
  })
  afterAll(() => listener.close())

  it('delivers a framed, complete transfer that a client can reassemble', async () => {
    const q = encodeQuery(3, 'x.test', RType.AXFR)
    const data = await new Promise<Buffer>((resolve, reject) => {
      const sock = net.connect(listener.port, '127.0.0.1', () => sock.write(Buffer.concat([Buffer.from([q.length >> 8, q.length & 0xff]), q])))
      let buf = Buffer.alloc(0)
      let soas = 0
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c])
        for (let pos = 0; ; ) {
          if (buf.length < pos + 2) break
          const len = buf.readUInt16BE(pos)
          if (buf.length < pos + 2 + len) break
          soas += decodeMessage(buf.subarray(pos + 2, pos + 2 + len)).answers.filter((a) => a.type === RType.SOA).length
          pos += 2 + len
          if (soas === 2) {
            sock.destroy()
            return resolve(buf)
          }
        }
      })
      sock.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 5000)
    })
    expect(data.length).toBeGreaterThan(30_000)
  })
})
