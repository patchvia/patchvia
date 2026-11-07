import { isIPv4, isIPv6 } from 'node:net'
import { nameToWire, normalizeName, validateName, ValidationError } from './names.js'
import { RType, type RTypeName } from './types.js'

export interface Rdata {
  wire: Buffer
  /** Target hostname for MX/NS/SRV, used for additional-section processing. */
  target?: string
}

function u16(n: number, what: string): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new ValidationError(`${what} must be 0-65535`)
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u32(n: number, what: string): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new ValidationError(`${what} must be 0-4294967295`)
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function int(s: string | undefined, what: string): number {
  if (s === undefined || !/^\d+$/.test(s)) throw new ValidationError(`${what} must be a number`)
  return Number(s)
}

function hostname(s: string | undefined, what: string): string {
  if (!s) throw new ValidationError(`${what} is required`)
  const n = normalizeName(s)
  validateName(n)
  return n
}

export function ipv4ToBuffer(ip: string): Buffer {
  if (!isIPv4(ip)) throw new ValidationError(`invalid IPv4 address: ${ip}`)
  return Buffer.from(ip.split('.').map(Number))
}

export function ipv6ToBuffer(ip: string): Buffer {
  if (!isIPv6(ip)) throw new ValidationError(`invalid IPv6 address: ${ip}`)
  let addr = ip.split('%')[0]!.toLowerCase()
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (m) {
    const [a, b, c, d] = m[2]!.split('.').map(Number) as [number, number, number, number]
    addr = m[1]! + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head = '', tail] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - h.length - t.length
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2))
  return out
}

/** Parses `"a" "b"` (quoted, with \" \\ \DDD escapes) or a bare string into 255-byte chunks. */
function txtChunks(content: string): Buffer[] {
  const trimmed = content.trim()
  const strings: Buffer[] = []
  if (trimmed.startsWith('"')) {
    let i = 0
    while (i < trimmed.length) {
      while (trimmed[i] === ' ') i++
      if (i >= trimmed.length) break
      if (trimmed[i] !== '"') throw new ValidationError('TXT strings must be quoted')
      i++
      const bytes: number[] = []
      let closed = false
      while (i < trimmed.length) {
        const ch = trimmed[i]!
        if (ch === '"') {
          closed = true
          i++
          break
        }
        if (ch === '\\') {
          const dec = /^\d{3}/.exec(trimmed.slice(i + 1))
          if (dec) {
            bytes.push(Number(dec[0]) & 0xff)
            i += 4
          } else {
            bytes.push(...Buffer.from(trimmed[i + 1] ?? '', 'utf8'))
            i += 2
          }
          continue
        }
        bytes.push(...Buffer.from(ch, 'utf8'))
        i++
      }
      if (!closed) throw new ValidationError('unterminated TXT string')
      strings.push(Buffer.from(bytes))
    }
  } else {
    strings.push(Buffer.from(content, 'utf8'))
  }
  const chunks: Buffer[] = []
  for (const s of strings) {
    if (s.length === 0) chunks.push(Buffer.alloc(0))
    for (let o = 0; o < s.length; o += 255) chunks.push(s.subarray(o, o + 255))
  }
  if (chunks.length === 0) throw new ValidationError('TXT content is empty')
  return chunks
}

/** Encodes presentation-format content (PowerDNS style, names absolute) into wire rdata. Throws ValidationError. */
export function encodeRdata(type: RTypeName, content: string): Rdata {
  const parts = content.trim().split(/\s+/)
  if (['A', 'AAAA', 'CNAME', 'NS', 'PTR'].includes(type) && parts.length !== 1) {
    throw new ValidationError(`${type} content must be a single value`)
  }
  switch (type) {
    case 'A':
      return { wire: ipv4ToBuffer(parts[0] ?? '') }
    case 'AAAA':
      return { wire: ipv6ToBuffer(parts[0] ?? '') }
    case 'CNAME':
    case 'NS':
    case 'PTR': {
      const target = hostname(parts[0], `${type} target`)
      return { wire: nameToWire(target), target: type === 'PTR' ? undefined : target }
    }
    case 'MX': {
      if (parts.length !== 2) throw new ValidationError('MX must be "<preference> <host>"')
      const target = hostname(parts[1], 'MX host')
      return {
        wire: Buffer.concat([u16(int(parts[0], 'MX preference'), 'MX preference'), nameToWire(target)]),
        target: target === '' ? undefined : target,
      }
    }
    case 'SRV': {
      if (parts.length !== 4) throw new ValidationError('SRV must be "<priority> <weight> <port> <target>"')
      const target = hostname(parts[3], 'SRV target')
      return {
        wire: Buffer.concat([
          u16(int(parts[0], 'SRV priority'), 'SRV priority'),
          u16(int(parts[1], 'SRV weight'), 'SRV weight'),
          u16(int(parts[2], 'SRV port'), 'SRV port'),
          nameToWire(target),
        ]),
        target: target === '' ? undefined : target,
      }
    }
    case 'TXT': {
      const chunks = txtChunks(content)
      return { wire: Buffer.concat(chunks.flatMap((c) => [Buffer.from([c.length]), c])) }
    }
    case 'CAA': {
      const m = /^(\d+)\s+([A-Za-z0-9]+)\s+(.*)$/s.exec(content.trim())
      if (!m) throw new ValidationError('CAA must be `<flags> <tag> "<value>"`')
      const flags = int(m[1], 'CAA flags')
      if (flags > 255) throw new ValidationError('CAA flags must be 0-255')
      let value = m[3]!.trim()
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
      return {
        wire: Buffer.concat([Buffer.from([flags]), Buffer.from([m[2]!.length]), Buffer.from(m[2]!, 'ascii'), Buffer.from(value, 'utf8')]),
      }
    }
    case 'SOA': {
      if (parts.length !== 7) throw new ValidationError('SOA must be "<mname> <rname> <serial> <refresh> <retry> <expire> <minimum>"')
      return {
        wire: Buffer.concat([
          nameToWire(hostname(parts[0], 'SOA mname')),
          nameToWire(hostname(parts[1], 'SOA rname')),
          u32(int(parts[2], 'SOA serial'), 'SOA serial'),
          u32(int(parts[3], 'SOA refresh'), 'SOA refresh'),
          u32(int(parts[4], 'SOA retry'), 'SOA retry'),
          u32(int(parts[5], 'SOA expire'), 'SOA expire'),
          u32(int(parts[6], 'SOA minimum'), 'SOA minimum'),
        ]),
      }
    }
  }
}

/** Last field of SOA rdata (negative-caching TTL). */
export function soaMinimum(soa: Rdata): number {
  return soa.wire.readUInt32BE(soa.wire.length - 4)
}

/** Serial field of SOA rdata (our wire form never uses compression). */
export function soaSerial(soa: Rdata): number {
  let p = 0
  for (let i = 0; i < 2; i++) {
    while (soa.wire[p] !== 0) p += soa.wire[p]! + 1
    p++
  }
  return soa.wire.readUInt32BE(p)
}

/** SOA rdata back to presentation form (names are only needed to skip past them here, so they are elided). */
export function soaToContent(soa: Rdata): string {
  let p = 0
  const names: string[] = []
  for (let i = 0; i < 2; i++) {
    const labels: string[] = []
    while (soa.wire[p] !== 0) {
      labels.push(soa.wire.toString('latin1', p + 1, p + 1 + soa.wire[p]!))
      p += soa.wire[p]! + 1
    }
    p++
    names.push(labels.join('.'))
  }
  const nums = [0, 4, 8, 12, 16].map((o) => soa.wire.readUInt32BE(p + o))
  return `${names[0]} ${names[1]} ${nums.join(' ')}`
}

export { RType }
