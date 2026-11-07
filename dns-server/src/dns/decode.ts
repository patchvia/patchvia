import { readName } from './codec.js'
import { RType } from './types.js'

export interface DecodedRR {
  name: string
  type: number
  class: number
  ttl: number
  /** Presentation content in our stored format, or null for types we do not serve */
  content: string | null
}

export interface DecodedMessage {
  id: number
  opcode: number
  rcode: number
  aa: boolean
  tc: boolean
  questions: { name: string; type: number; class: number }[]
  answers: DecodedRR[]
  authority: DecodedRR[]
  additional: DecodedRR[]
}

export function ipv6ToString(b: Buffer): string {
  const g = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2))
  // Compress the longest run of zero groups (at least two), as RFC 5952 recommends
  let best = { at: -1, len: 0 }
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && g[j] === 0) j++
    if (j - i > best.len) best = { at: i, len: j - i }
    i = j
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(':')
  if (best.len < 2) return hex(g)
  return `${hex(g.slice(0, best.at))}::${hex(g.slice(best.at + best.len))}`
}

function txtEscape(chunk: Buffer): string {
  const asText = chunk.toString('utf8')
  const valid = Buffer.from(asText, 'utf8').equals(chunk)
  const bytes = valid ? Buffer.from(asText, 'utf8') : chunk
  let out = ''
  if (valid) {
    for (const ch of asText) {
      const code = ch.codePointAt(0)!
      if (ch === '"' || ch === '\\') out += `\\${ch}`
      else if (code < 0x20 || code === 0x7f) out += `\\${String(code).padStart(3, '0')}`
      else out += ch
    }
    return out
  }
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) out += `\\${String.fromCharCode(b)}`
    else if (b < 0x20 || b > 0x7e) out += `\\${String(b).padStart(3, '0')}`
    else out += String.fromCharCode(b)
  }
  return out
}

/** Wire rdata (names may be compressed against the whole message) to our content format. */
export function rdataToContent(type: number, buf: Buffer, start: number, len: number): string | null {
  const end = start + len
  const d = buf.subarray(start, end)
  const name = (at: number) => readName(buf, at)
  switch (type) {
    case RType.A:
      return len === 4 ? [...d].join('.') : null
    case RType.AAAA:
      return len === 16 ? ipv6ToString(d) : null
    case RType.NS:
    case RType.CNAME:
    case RType.PTR:
      return name(start).raw.toLowerCase()
    case RType.MX:
      return `${d.readUInt16BE(0)} ${name(start + 2).raw.toLowerCase()}`
    case RType.SRV:
      return `${d.readUInt16BE(0)} ${d.readUInt16BE(2)} ${d.readUInt16BE(4)} ${name(start + 6).raw.toLowerCase()}`
    case RType.TXT: {
      const parts: string[] = []
      for (let i = 0; i < d.length; ) {
        const n = d[i]!
        if (i + 1 + n > d.length) return null
        parts.push(`"${txtEscape(d.subarray(i + 1, i + 1 + n))}"`)
        i += 1 + n
      }
      return parts.length ? parts.join(' ') : null
    }
    case RType.CAA: {
      if (len < 2) return null
      const tagLen = d[1]!
      if (2 + tagLen > len) return null
      return `${d[0]} ${d.toString('ascii', 2, 2 + tagLen)} "${d.toString('utf8', 2 + tagLen).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    case RType.SOA: {
      const m = name(start)
      const r = name(m.next)
      const n = r.next
      if (n + 20 > end) return null
      const f = [0, 4, 8, 12, 16].map((o) => buf.readUInt32BE(n + o))
      return `${m.raw.toLowerCase()} ${r.raw.toLowerCase()} ${f.join(' ')}`
    }
    default:
      return null
  }
}

/** Full message parse, used when acting as a client (AXFR in, NOTIFY acks). Throws on malformed data. */
export function decodeMessage(buf: Buffer): DecodedMessage {
  if (buf.length < 12) throw new Error('short header')
  const flags = buf.readUInt16BE(2)
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o)) as [number, number, number, number]
  let pos = 12
  const questions: DecodedMessage['questions'] = []
  for (let i = 0; i < counts[0]; i++) {
    const n = readName(buf, pos)
    questions.push({ name: n.raw.toLowerCase(), type: buf.readUInt16BE(n.next), class: buf.readUInt16BE(n.next + 2) })
    pos = n.next + 4
  }
  const readRRs = (count: number): DecodedRR[] => {
    const out: DecodedRR[] = []
    for (let i = 0; i < count; i++) {
      const n = readName(buf, pos)
      if (n.next + 10 > buf.length) throw new Error('truncated record')
      const type = buf.readUInt16BE(n.next)
      const len = buf.readUInt16BE(n.next + 8)
      const start = n.next + 10
      if (start + len > buf.length) throw new Error('truncated rdata')
      out.push({
        name: n.raw.toLowerCase(),
        type,
        class: buf.readUInt16BE(n.next + 2),
        ttl: buf.readUInt32BE(n.next + 4),
        content: type === RType.OPT ? null : rdataToContent(type, buf, start, len),
      })
      pos = start + len
    }
    return out
  }
  const answers = readRRs(counts[1])
  const authority = readRRs(counts[2])
  const additional = readRRs(counts[3])
  return { id: buf.readUInt16BE(0), opcode: (flags >> 11) & 0xf, rcode: flags & 0xf, aa: (flags & 0x0400) !== 0, tc: (flags & 0x0200) !== 0, questions, answers, authority, additional }
}
