import dgram from 'node:dgram'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeQuery } from '../src/dns/codec.js'
import { listenTcp, listenUdp, type Listener } from '../src/dns/listeners.js'
import { RCode, RType } from '../src/dns/types.js'
import { indexOf, parseResponse } from './helpers.js'

const idx = indexOf('net.test', [
  { name: 'net.test', type: 'SOA', ttl: 60, contents: ['ns.net.test h.net.test 1 1 1 1 1'] },
  { name: 'net.test', type: 'NS', ttl: 60, contents: ['ns.net.test'] },
  { name: 'net.test', type: 'A', ttl: 60, contents: ['192.0.2.1'] },
])

let udp: Listener
let tcp: Listener
beforeAll(async () => {
  udp = await listenUdp(idx, '127.0.0.1', 0)
  tcp = await listenTcp(idx, '127.0.0.1', udp.port)
})
afterAll(async () => {
  await Promise.all([udp.close(), tcp.close()])
})

function udpQuery(packet: Buffer, wait = 1000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    const timer = setTimeout(() => {
      s.close()
      resolve(null)
    }, wait)
    s.on('message', (m) => {
      clearTimeout(timer)
      s.close()
      resolve(m)
    })
    s.send(packet, udp.port, '127.0.0.1')
  })
}

describe('network listeners', () => {
  it('answers over UDP', async () => {
    const res = parseResponse((await udpQuery(encodeQuery(7, 'net.test', RType.A)))!)
    expect(res.id).toBe(7)
    expect(res.answers[0]!.text).toBe('192.0.2.1')
  })

  it('answers two pipelined queries over one TCP connection', async () => {
    const frame = (b: Buffer) => Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b])
    const got = await new Promise<Buffer>((resolve) => {
      const sock = net.connect(tcp.port, '127.0.0.1', () => {
        sock.write(Buffer.concat([frame(encodeQuery(1, 'net.test', RType.A)), frame(encodeQuery(2, 'nope.net.test', RType.A))]))
      })
      let data = Buffer.alloc(0)
      sock.on('data', (c) => {
        data = Buffer.concat([data, c])
        // two complete frames?
        if (data.length < 2) return
        const l1 = data.readUInt16BE(0)
        if (data.length < 2 + l1 + 2) return
        const l2 = data.readUInt16BE(2 + l1)
        if (data.length >= 2 + l1 + 2 + l2) {
          sock.destroy()
          resolve(data)
        }
      })
    })
    const l1 = got.readUInt16BE(0)
    expect(parseResponse(got.subarray(2, 2 + l1)).id).toBe(1)
    const second = parseResponse(got.subarray(2 + l1 + 2))
    expect(second.id).toBe(2)
    expect(second.rcode).toBe(RCode.NXDOMAIN)
  })

  it('replies FORMERR to malformed packets that have a header, drops shorter ones, ignores responses', async () => {
    const bad = Buffer.from('abcd0100000100000000000005', 'hex') // qdcount=1 but truncated question
    const res = parseResponse((await udpQuery(bad))!)
    expect(res.rcode).toBe(RCode.FORMERR)
    expect(await udpQuery(Buffer.from([1, 2, 3]), 200)).toBeNull()
    const asResponse = encodeQuery(9, 'net.test', RType.A)
    asResponse[2]! |= 0x80
    expect(await udpQuery(asResponse, 200)).toBeNull()
  })
})
