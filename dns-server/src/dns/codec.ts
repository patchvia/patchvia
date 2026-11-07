import { labelsOf } from './names.js'
import { RType, type Edns, type Query, type Question, type Response, type RR } from './types.js'

export class FormatError extends Error {}

export function readName(buf: Buffer, offset: number): { raw: string; next: number } {
  let pos = offset
  let next = -1
  let jumps = 0
  const labels: string[] = []
  for (;;) {
    if (pos >= buf.length) throw new FormatError('name runs past end of message')
    const len = buf[pos]!
    if (len === 0) {
      pos++
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new FormatError('truncated compression pointer')
      if (next < 0) next = pos + 2
      if (++jumps > 32) throw new FormatError('compression loop')
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!
      continue
    }
    if (len & 0xc0) throw new FormatError('bad label type')
    pos++
    if (pos + len > buf.length) throw new FormatError('label runs past end of message')
    labels.push(buf.toString('latin1', pos, pos + len))
    pos += len
  }
  return { raw: labels.join('.'), next: next < 0 ? pos : next }
}

/** Decodes a query. Throws FormatError when the message is malformed. */
export function decodeQuery(buf: Buffer): Query & { isResponse: boolean } {
  if (buf.length < 12) throw new FormatError('short header')
  const flags = buf.readUInt16BE(2)
  const qd = buf.readUInt16BE(4)
  const counts = [buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)] as const
  let pos = 12
  const questions: Question[] = []
  for (let i = 0; i < qd; i++) {
    const { raw, next } = readName(buf, pos)
    if (next + 4 > buf.length) throw new FormatError('truncated question')
    questions.push({ name: raw.toLowerCase(), rawName: raw, type: buf.readUInt16BE(next), class: buf.readUInt16BE(next + 2) })
    pos = next + 4
  }
  let edns: Edns | undefined
  let ixfrSerial: number | undefined
  const total = counts[0] + counts[1] + counts[2]
  for (let i = 0; i < total; i++) {
    const { next } = readName(buf, pos)
    if (next + 10 > buf.length) throw new FormatError('truncated record')
    const type = buf.readUInt16BE(next)
    const klass = buf.readUInt16BE(next + 2)
    const ttl = buf.readUInt32BE(next + 4)
    const rdlen = buf.readUInt16BE(next + 8)
    if (next + 10 + rdlen > buf.length) throw new FormatError('truncated rdata')
    if (type === RType.SOA && i >= counts[0] && i < counts[0] + counts[1] && rdlen >= 22) {
      const mname = readName(buf, next + 10)
      const rname = readName(buf, mname.next)
      if (rname.next + 4 <= buf.length) ixfrSerial = buf.readUInt32BE(rname.next)
    }
    if (type === RType.OPT && i >= counts[0] + counts[1]) {
      edns = { payload: klass, version: (ttl >>> 16) & 0xff, do: (ttl & 0x8000) !== 0 }
    }
    pos = next + 10 + rdlen
  }
  return {
    id: buf.readUInt16BE(0),
    isResponse: (flags & 0x8000) !== 0,
    opcode: (flags >> 11) & 0xf,
    rd: (flags & 0x0100) !== 0,
    cd: (flags & 0x0010) !== 0,
    questions,
    edns,
    ixfrSerial,
  }
}

class Writer {
  private buf = Buffer.allocUnsafe(65535)
  pos = 0
  private offsets = new Map<string, number>()

  u8(n: number) {
    this.buf[this.pos++] = n
  }
  u16(n: number) {
    this.buf.writeUInt16BE(n, this.pos)
    this.pos += 2
  }
  u32(n: number) {
    this.buf.writeUInt32BE(n, this.pos)
    this.pos += 4
  }
  bytes(b: Buffer) {
    b.copy(this.buf, this.pos)
    this.pos += b.length
  }
  /** Writes a name with suffix compression. `raw` preserves the case to put on the wire. */
  name(name: string, raw = name) {
    const lower = labelsOf(name)
    const wire = labelsOf(raw)
    for (let i = 0; i < lower.length; i++) {
      const suffix = lower.slice(i).join('.')
      const seen = this.offsets.get(suffix)
      if (seen !== undefined) {
        this.u16(0xc000 | seen)
        return
      }
      if (this.pos < 0x3fff) this.offsets.set(suffix, this.pos)
      const label = Buffer.from(wire[i]!, 'latin1')
      this.u8(label.length)
      this.bytes(label)
    }
    this.u8(0)
  }
  rr(r: RR, qnames: Map<string, string>) {
    this.name(r.name, qnames.get(r.name) ?? r.name)
    this.u16(r.type)
    this.u16(1)
    this.u32(r.ttl)
    this.u16(r.rdata.length)
    this.bytes(r.rdata)
  }
  done(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.pos))
  }
}

function write(res: Response, opts: { records: boolean; additional: boolean; tc: boolean }): Buffer {
  const w = new Writer()
  const answers = opts.records ? res.answers : []
  const authority = opts.records ? res.authority : []
  const additional = opts.records && opts.additional ? res.additional : []
  const hasEdns = res.edns !== undefined
  w.u16(res.id)
  w.u16(
    0x8000 |
      (res.opcode << 11) |
      (res.aa ? 0x0400 : 0) |
      (opts.tc ? 0x0200 : 0) |
      (res.rd ? 0x0100 : 0) |
      (res.cd ? 0x0010 : 0) |
      (res.rcode & 0xf),
  )
  w.u16(res.questions.length)
  w.u16(answers.length)
  w.u16(authority.length)
  w.u16(additional.length + (hasEdns ? 1 : 0))
  const qnames = new Map<string, string>()
  for (const q of res.questions) {
    w.name(q.name, q.rawName)
    w.u16(q.type)
    w.u16(q.class)
    qnames.set(q.name, q.rawName)
  }
  for (const r of answers) w.rr(r, qnames)
  for (const r of authority) w.rr(r, qnames)
  for (const r of additional) w.rr(r, qnames)
  if (res.edns) {
    w.u8(0)
    w.u16(RType.OPT)
    w.u16(res.edns.payload)
    w.u32((((res.rcode >> 4) << 24) | (res.edns.do ? 0x8000 : 0)) >>> 0)
    w.u16(0)
  }
  return w.done()
}

/** Encodes a response, dropping the additional section and then setting TC if it exceeds maxSize. */
export function encodeResponse(res: Response, maxSize: number): Buffer {
  let out = write(res, { records: true, additional: true, tc: res.tc })
  if (out.length <= maxSize) return out
  out = write(res, { records: true, additional: false, tc: res.tc })
  if (out.length <= maxSize) return out
  return write(res, { records: false, additional: false, tc: true })
}

/** Builds a query message (used by tests and, later, NOTIFY/AXFR clients). */
export function encodeQuery(
  id: number,
  name: string,
  type: number,
  opts: { edns?: number; rd?: boolean; opcode?: number; aa?: boolean; do?: boolean } = {},
): Buffer {
  const w = new Writer()
  w.u16(id)
  w.u16(((opts.opcode ?? 0) << 11) | (opts.aa ? 0x0400 : 0) | (opts.rd ? 0x0100 : 0))
  w.u16(1)
  w.u16(0)
  w.u16(0)
  w.u16(opts.edns ? 1 : 0)
  w.name(name)
  w.u16(type)
  w.u16(1)
  if (opts.edns) {
    w.u8(0)
    w.u16(RType.OPT)
    w.u16(opts.edns)
    w.u32(opts.do ? 0x8000 : 0)
    w.u16(0)
  }
  return w.done()
}

/** RFC 1996 NOTIFY for `zone`: opcode 4, authoritative, question SOA/IN. */
export function encodeNotify(id: number, zone: string): Buffer {
  return encodeQuery(id, zone, RType.SOA, { opcode: 4, aa: true })
}
