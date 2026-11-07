import { isAtOrBelow, normalizeName } from '../dns/names.js'
import { STORABLE_TYPES, type RTypeName } from '../dns/types.js'
import { contentIssues } from './zonefile-content.js'
import type { RRsetInput } from './zone.js'

export interface ParseIssue {
  line: number
  message: string
}

export interface ParsedZoneFile {
  /** From $ORIGIN or the caller; undefined when neither was given and every name was absolute */
  origin?: string
  rrsets: RRsetInput[]
  /** Record types we do not serve (DNSKEY, RRSIG…), with counts */
  skipped: Record<string, number>
  warnings: ParseIssue[]
  errors: ParseIssue[]
}

interface Token {
  text: string
  quoted: boolean
}

interface Entry {
  line: number
  /** The line began with whitespace: the owner name is omitted and inherited */
  inheritsOwner: boolean
  tokens: Token[]
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }

/** "300", "1h", "1h30m", "2w" → seconds; undefined when it is not a TTL. */
export function parseTtl(s: string): number | undefined {
  if (!/^(\d+[smhdw]?)+$/i.test(s)) return undefined
  let total = 0
  for (const m of s.matchAll(/(\d+)([smhdw]?)/gi)) total += Number(m[1]) * (UNITS[m[2]!.toLowerCase()] ?? 1)
  return total <= 2147483647 ? total : undefined
}

/**
 * Splits master-file text into logical entries: handles ; comments, "quoted strings" (with escapes), and ( ) line
 * continuation, which is how multi-line SOA records are written.
 */
function tokenize(text: string, errors: ParseIssue[]): Entry[] {
  const entries: Entry[] = []
  let tokens: Token[] = []
  let cur = ''
  let inWord = false
  let depth = 0
  let line = 1
  let entryLine = 1
  let inherits = false
  let atLineStart = true

  const endWord = () => {
    if (inWord) tokens.push({ text: cur, quoted: false })
    cur = ''
    inWord = false
  }
  const endEntry = () => {
    endWord()
    if (tokens.length) entries.push({ line: entryLine, inheritsOwner: inherits, tokens })
    tokens = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (atLineStart && depth === 0) {
      entryLine = line
      inherits = ch === ' ' || ch === '\t'
      atLineStart = false
    }
    if (ch === '"') {
      endWord()
      let j = i + 1
      let raw = ''
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) raw += text[j]! + text[++j]!
        else raw += text[j]
        if (text[j] === '\n') line++
      }
      if (j >= text.length) {
        errors.push({ line: entryLine, message: 'unterminated quoted string' })
        break
      }
      tokens.push({ text: raw, quoted: true })
      i = j
    } else if (ch === ';') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else if (ch === '(') {
      endWord()
      depth++
    } else if (ch === ')') {
      endWord()
      if (depth === 0) errors.push({ line, message: 'unbalanced )' })
      else depth--
    } else if (ch === '\n') {
      line++
      if (depth === 0) {
        endEntry()
        atLineStart = true
      } else endWord()
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
    } else {
      inWord = true
      cur += ch
    }
  }
  if (depth > 0) errors.push({ line: entryLine, message: 'unclosed (' })
  endEntry()
  return entries
}

const isStorable = (t: string): t is RTypeName => (STORABLE_TYPES as readonly string[]).includes(t)

/**
 * Parses an RFC 1035 master file. It never throws: problems are returned as `errors` (the file cannot be imported)
 * or `warnings` / `skipped` (it can, with something left out).
 */
export function parseZoneFile(text: string, opts: { origin?: string; defaultTtl?: number } = {}): ParsedZoneFile {
  const errors: ParseIssue[] = []
  const warnings: ParseIssue[] = []
  const skipped: Record<string, number> = {}
  let origin = opts.origin ? normalizeName(opts.origin) : undefined
  let fileOrigin: string | undefined
  let defaultTtl: number | undefined
  let lastTtl: number | undefined
  let lastOwner: string | undefined
  const records: { name: string; type: RTypeName; ttl: number | undefined; content: string; line: number }[] = []

  const abs = (tok: string, line: number): string | undefined => {
    if (tok === '@') {
      if (origin === undefined) errors.push({ line, message: '"@" used but no $ORIGIN is set' })
      return origin
    }
    if (tok.endsWith('.')) return normalizeName(tok)
    if (origin === undefined) {
      errors.push({ line, message: `relative name "${tok}" but no $ORIGIN is set` })
      return undefined
    }
    return normalizeName(`${tok}.${origin}`)
  }

  for (const e of tokenize(text, errors)) {
    const t = e.tokens
    const first = t[0]!.text
    if (!e.inheritsOwner && first.startsWith('$')) {
      const dir = first.toUpperCase()
      if (dir === '$ORIGIN') {
        const v = t[1]?.text
        if (!v || !v.endsWith('.')) errors.push({ line: e.line, message: '$ORIGIN needs an absolute name ending in a dot' })
        else {
          origin = normalizeName(v)
          fileOrigin ??= origin
        }
      } else if (dir === '$TTL') {
        const v = t[1] ? parseTtl(t[1].text) : undefined
        if (v === undefined) errors.push({ line: e.line, message: '$TTL needs a time like 3600 or 1h' })
        else defaultTtl = v
      } else errors.push({ line: e.line, message: `${first} is not supported` })
      continue
    }

    let i = 0
    let owner: string | undefined
    if (e.inheritsOwner) {
      owner = lastOwner
      if (owner === undefined) {
        errors.push({ line: e.line, message: 'record has no owner name and there is no previous record' })
        continue
      }
    } else {
      owner = abs(first, e.line)
      i = 1
      if (owner === undefined) continue
    }
    lastOwner = owner

    // Optional TTL and class, in either order
    let ttl: number | undefined
    for (let k = 0; k < 2; k++) {
      const tok = t[i]?.text
      if (tok === undefined) break
      if (!t[i]!.quoted && /^(IN|CH|HS|CS)$/i.test(tok)) {
        if (tok.toUpperCase() !== 'IN') errors.push({ line: e.line, message: `class ${tok.toUpperCase()} is not supported` })
        i++
      } else if (!t[i]!.quoted && ttl === undefined && parseTtl(tok) !== undefined && !/^[A-Za-z]/.test(tok)) {
        ttl = parseTtl(tok)
        i++
      }
    }
    const type = t[i]?.text.toUpperCase()
    if (!type) {
      errors.push({ line: e.line, message: 'record has no type' })
      continue
    }
    const rdata = t.slice(i + 1)

    if (!isStorable(type)) {
      skipped[type] = (skipped[type] ?? 0) + 1
      continue
    }
    const content = contentFromTokens(type, rdata, abs, e.line, errors)
    if (content === undefined) continue
    records.push({ name: owner, type, ttl: ttl ?? lastTtlFor(ttl), content, line: e.line })
    if (ttl !== undefined) lastTtl = ttl
  }

  function lastTtlFor(explicit: number | undefined): number | undefined {
    return explicit ?? defaultTtl ?? lastTtl
  }

  // Group into RRsets (one TTL each: the lowest, as RFC 2181 5.2 requires)
  const sets = new Map<string, RRsetInput>()
  const ttlFallback = opts.defaultTtl ?? 3600
  for (const r of records) {
    if (origin !== undefined && !isAtOrBelow(r.name, origin)) {
      warnings.push({ line: r.line, message: `${r.name} is outside ${origin} and was skipped` })
      skipped['out-of-zone'] = (skipped['out-of-zone'] ?? 0) + 1
      continue
    }
    const ttl = r.ttl ?? ttlFallback
    const key = `${r.name}|${r.type}`
    const set = sets.get(key)
    if (!set) sets.set(key, { name: r.name, type: r.type, ttl, contents: [r.content] })
    else {
      if (set.ttl !== ttl) {
        warnings.push({ line: r.line, message: `${r.type} ${r.name} has records with different TTLs; using the lowest` })
        set.ttl = Math.min(set.ttl, ttl)
      }
      if (!set.contents.includes(r.content)) set.contents.push(r.content)
    }
  }

  const rrsets = [...sets.values()]
  for (const issue of contentIssues(rrsets, origin ?? fileOrigin)) errors.push(issue)
  return { origin: origin ?? fileOrigin, rrsets, skipped, warnings, errors }
}

type Abs = (tok: string, line: number) => string | undefined

/** Master-file rdata tokens to our stored content string. Reports a problem and returns undefined when malformed. */
function contentFromTokens(type: RTypeName, rd: Token[], abs: Abs, line: number, errors: ParseIssue[]): string | undefined {
  const fail = (message: string) => {
    errors.push({ line, message })
    return undefined
  }
  const text = (i: number) => rd[i]?.text
  const name = (i: number): string | undefined => {
    const v = text(i)
    return v === undefined ? undefined : abs(v, line)
  }
  switch (type) {
    case 'A':
    case 'AAAA':
      return rd.length === 1 ? text(0) : fail(`${type} needs exactly one address`)
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return rd.length === 1 ? name(0) : fail(`${type} needs exactly one name`)
    case 'MX': {
      if (rd.length !== 2) return fail('MX needs a preference and a mail server')
      const host = name(1)
      return host === undefined ? undefined : `${text(0)} ${host}`
    }
    case 'SRV': {
      if (rd.length !== 4) return fail('SRV needs priority, weight, port and target')
      const host = name(3)
      return host === undefined ? undefined : `${text(0)} ${text(1)} ${text(2)} ${host}`
    }
    case 'TXT': {
      if (rd.length === 0) return fail('TXT needs at least one string')
      // Quoted strings keep their escapes; a bare word is a one-word string
      return rd.map((tk) => `"${tk.text}"`).join(' ')
    }
    case 'CAA': {
      if (rd.length !== 3) return fail('CAA needs flags, a tag and a value')
      return `${text(0)} ${text(1)} "${text(2)}"`
    }
    case 'SOA': {
      if (rd.length !== 7) return fail('SOA needs mname, rname, serial, refresh, retry, expire and minimum')
      const m = name(0)
      const r = name(1)
      if (m === undefined || r === undefined) return undefined
      const nums = [text(2)!, ...[3, 4, 5, 6].map((k) => String(parseTtl(text(k)!) ?? NaN))]
      if (nums.some((n) => !/^\d+$/.test(n))) return fail('SOA serial and timers must be numbers (units like 1h are allowed on timers)')
      return `${m} ${r} ${nums.join(' ')}`
    }
  }
}
