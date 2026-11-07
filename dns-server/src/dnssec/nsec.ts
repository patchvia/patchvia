import { RType } from '../dns/types.js'
import { nameToWire } from '../dns/names.js'

/**
 * Canonical DNS name order (RFC 4034 6.1): compare label by label from the rightmost, each label as lower-case bytes,
 * and an ancestor sorts before its descendants. This is not alphabetical order: "z.a" comes before "a.b".
 */
export function canonicalCompare(a: string, b: string): number {
  if (a === b) return 0
  const la = a === '' ? [] : a.split('.').reverse()
  const lb = b === '' ? [] : b.split('.').reverse()
  const n = Math.min(la.length, lb.length)
  for (let i = 0; i < n; i++) {
    const c = Buffer.compare(Buffer.from(la[i]!, 'latin1'), Buffer.from(lb[i]!, 'latin1'))
    if (c !== 0) return c
  }
  return la.length - lb.length
}

/** NSEC type bit maps (RFC 4034 4.1.2): windows of 256 types, each a length-prefixed bit field. */
export function typeBitmap(types: Iterable<number>): Buffer {
  const windows = new Map<number, number[]>()
  for (const t of new Set(types)) {
    const w = t >> 8
    if (!windows.has(w)) windows.set(w, [])
    windows.get(w)!.push(t & 255)
  }
  const out: Buffer[] = []
  for (const w of [...windows.keys()].sort((a, b) => a - b)) {
    const bits = windows.get(w)!
    const bytes = Buffer.alloc(Math.floor(Math.max(...bits) / 8) + 1)
    for (const bit of bits) bytes[bit >> 3] = bytes[bit >> 3]! | (0x80 >> (bit & 7))
    out.push(Buffer.from([w, bytes.length]), bytes)
  }
  return Buffer.concat(out)
}

/** The types listed in an NSEC bit map, for tests and diagnostics. */
export function bitmapTypes(bitmap: Buffer): number[] {
  const out: number[] = []
  for (let p = 0; p < bitmap.length; ) {
    const w = bitmap[p]!
    const len = bitmap[p + 1]!
    for (let i = 0; i < len; i++) for (let b = 0; b < 8; b++) if (bitmap[p + 2 + i]! & (0x80 >> b)) out.push(w * 256 + i * 8 + b)
    p += 2 + len
  }
  return out
}

export interface NsecEntry {
  name: string
  next: string
  rrset: { name: string; type: number; ttl: number; rdatas: { wire: Buffer }[] }
}

/**
 * The zone's NSEC chain: every name that owns authoritative data, in canonical order, each pointing at the next and
 * the last back at the apex. `typesAt` lists the types present at a name (without NSEC and RRSIG, which are added).
 */
export function buildNsecChain(names: string[], typesAt: (name: string) => number[], ttl: number): NsecChain {
  const sorted = [...names].sort(canonicalCompare)
  const entries: NsecEntry[] = sorted.map((name, i) => {
    const next = sorted[(i + 1) % sorted.length]!
    const types = [...typesAt(name), RType.NSEC, RType.RRSIG]
    return {
      name,
      next,
      rrset: { name, type: RType.NSEC, ttl, rdatas: [{ wire: Buffer.concat([nameToWire(next), typeBitmap(types)]) }] },
    }
  })
  return new NsecChain(entries)
}

export class NsecChain {
  private readonly byName: Map<string, NsecEntry>

  constructor(readonly entries: NsecEntry[]) {
    this.byName = new Map(entries.map((e) => [e.name, e]))
  }

  /** The NSEC owned by exactly this name, if it has one. */
  matching(name: string): NsecEntry | undefined {
    return this.byName.get(name)
  }

  /** The NSEC whose owner sorts immediately before `name`: its span contains `name`, proving nothing is there. */
  covering(name: string): NsecEntry {
    let lo = 0
    let hi = this.entries.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (canonicalCompare(this.entries[mid]!.name, name) <= 0) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return this.entries[found]!
  }
}
