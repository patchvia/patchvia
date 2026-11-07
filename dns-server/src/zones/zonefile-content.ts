import { encodeRdata } from '../dns/rdata.js'
import { isAtOrBelow, normalizeName, validateName } from '../dns/names.js'
import type { RRsetInput } from './zone.js'

interface Issue {
  line: number
  message: string
}

/**
 * Validates parsed RRsets with the same rules the server enforces on writes, so an import that would be rejected
 * is reported with the offending record instead of failing halfway. Line 0 means "not tied to one line".
 */
export function contentIssues(sets: RRsetInput[], origin: string | undefined): Issue[] {
  const out: Issue[] = []
  const typesAt = new Map<string, Set<string>>()
  for (const s of sets) {
    try {
      validateName(normalizeName(s.name), { allowWildcard: true })
    } catch (e) {
      out.push({ line: 0, message: (e as Error).message })
      continue
    }
    for (const c of s.contents) {
      try {
        encodeRdata(s.type, c)
      } catch (e) {
        out.push({ line: 0, message: `${s.type} ${s.name}: ${(e as Error).message}` })
      }
    }
    if (s.type === 'CNAME' && s.contents.length > 1) out.push({ line: 0, message: `${s.name} has more than one CNAME` })
    if (s.type === 'SOA' && origin !== undefined && s.name !== origin) out.push({ line: 0, message: 'SOA must be at the zone apex' })
    if (s.type === 'CNAME' && origin !== undefined && s.name === origin) out.push({ line: 0, message: 'a CNAME cannot be at the zone apex' })
    if (origin !== undefined && !isAtOrBelow(s.name, origin)) continue
    const set = typesAt.get(s.name) ?? new Set()
    set.add(s.type)
    typesAt.set(s.name, set)
  }
  for (const [name, types] of typesAt) {
    if (types.has('CNAME') && types.size > 1) out.push({ line: 0, message: `${name} has a CNAME together with other record types` })
  }
  return out
}
