import { readName, encodeQuery } from '../src/dns/codec.js'
import { handlePacket } from '../src/dns/handler.js'
import { RType } from '../src/dns/types.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { buildZone, type RRsetInput } from '../src/zones/zone.js'

export interface ParsedRR {
  name: string
  type: number
  ttl: number
  rdata: Buffer
  /** Text form for common types. */
  text: string
}

export interface Parsed {
  id: number
  aa: boolean
  tc: boolean
  rcode: number
  question: { name: string; type: number }
  answers: ParsedRR[]
  authority: ParsedRR[]
  additional: ParsedRR[]
  edns?: { payload: number }
  size: number
}

function text(buf: Buffer, type: number, start: number, len: number): string {
  const d = buf.subarray(start, start + len)
  switch (type) {
    case RType.A:
      return [...d].join('.')
    case RType.AAAA: {
      const g: string[] = []
      for (let i = 0; i < 16; i += 2) g.push(d.readUInt16BE(i).toString(16))
      return g.join(':')
    }
    case RType.CNAME:
    case RType.NS:
    case RType.PTR:
      return readName(buf, start).raw
    case RType.MX:
      return `${d.readUInt16BE(0)} ${readName(buf, start + 2).raw}`
    case RType.SRV:
      return `${d.readUInt16BE(0)} ${d.readUInt16BE(2)} ${d.readUInt16BE(4)} ${readName(buf, start + 6).raw}`
    case RType.TXT: {
      const out: string[] = []
      for (let i = 0; i < d.length; ) {
        out.push(d.toString('utf8', i + 1, i + 1 + d[i]!))
        i += 1 + d[i]!
      }
      return out.join('')
    }
    case RType.NSEC:
      return readName(buf, start).raw // the next owner name; the type bitmap follows it
    case RType.CAA:
      return `${d[0]} ${d.toString('ascii', 2, 2 + d[1]!)} ${d.toString('utf8', 2 + d[1]!)}`
    case RType.SOA: {
      const m = readName(buf, start)
      const r = readName(buf, m.next)
      const n = r.next
      return `${m.raw} ${r.raw} ${buf.readUInt32BE(n)} ${buf.readUInt32BE(n + 4)} ${buf.readUInt32BE(n + 8)} ${buf.readUInt32BE(n + 12)} ${buf.readUInt32BE(n + 16)}`
    }
    default:
      return d.toString('hex')
  }
}

export function parseResponse(buf: Buffer): Parsed {
  const flags = buf.readUInt16BE(2)
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o)) as [number, number, number, number]
  let pos = 12
  let question = { name: '', type: 0 }
  for (let i = 0; i < counts[0]; i++) {
    const n = readName(buf, pos)
    question = { name: n.raw, type: buf.readUInt16BE(n.next) }
    pos = n.next + 4
  }
  let edns: { payload: number } | undefined
  const read = (count: number): ParsedRR[] => {
    const out: ParsedRR[] = []
    for (let i = 0; i < count; i++) {
      const n = readName(buf, pos)
      const type = buf.readUInt16BE(n.next)
      const klass = buf.readUInt16BE(n.next + 2)
      const ttl = buf.readUInt32BE(n.next + 4)
      const len = buf.readUInt16BE(n.next + 8)
      const start = n.next + 10
      pos = start + len
      if (type === RType.OPT) edns = { payload: klass }
      else out.push({ name: n.raw, type, ttl, rdata: buf.subarray(start, start + len), text: text(buf, type, start, len) })
    }
    return out
  }
  const answers = read(counts[1])
  const authority = read(counts[2])
  const additional = read(counts[3])
  return {
    id: buf.readUInt16BE(0),
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rcode: flags & 0xf,
    question,
    answers,
    authority,
    additional,
    edns,
    size: buf.length,
  }
}

export function indexOf(apex: string, sets: RRsetInput[]): ZoneIndex {
  const idx = new ZoneIndex()
  idx.set(buildZone(apex, sets))
  return idx
}

export function ask(idx: ZoneIndex, name: string, type: number, opts: { edns?: number; transport?: 'udp' | 'tcp' } = {}): Parsed {
  const out = handlePacket(idx, encodeQuery(0x1234, name, type, { edns: opts.edns }), opts.transport ?? 'udp')
  if (!out) throw new Error('packet dropped')
  return parseResponse(out)
}
