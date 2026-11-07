// Turns PowerDNS gmysql rows into an RFC 1035 zone file, which Patchvia's import endpoint parses and validates.
// Pure functions only: nothing here touches the network or the database.

const DEFAULT_TTL = 3600
/** Types whose content is a host name: stored without a trailing dot in PowerDNS, so it would read as relative in a zone file */
const NAME_TYPES = new Set(['CNAME', 'NS', 'PTR', 'DNAME'])

const strip = (n) => String(n).trim().replace(/\.$/, '').toLowerCase()
/** An absolute name for a zone file ("." is the root) */
export const fqdn = (n) => (strip(n) === '' ? '.' : strip(n) + '.')

function quoteTxt(content) {
  const c = content.trim()
  if (c.startsWith('"')) return c // already quoted, possibly several strings
  return '"' + c.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * The record's data in zone-file form, or null when it cannot be expressed. PowerDNS 4 keeps the MX/SRV priority inside
 * `content`, older schemas keep it in the `prio` column: both are accepted.
 */
export function rdata(type, content, prio) {
  const c = String(content ?? '').trim()
  if (!c) return null
  const f = c.split(/\s+/)
  switch (type) {
    case 'MX': {
      if (f.length === 2 && /^\d+$/.test(f[0])) return `${f[0]} ${fqdn(f[1])}`
      if (f.length === 1 && prio != null) return `${prio} ${fqdn(f[0])}`
      return null
    }
    case 'SRV': {
      if (f.length === 4 && /^\d+$/.test(f[0])) return `${f[0]} ${f[1]} ${f[2]} ${fqdn(f[3])}`
      if (f.length === 3 && prio != null) return `${prio} ${f[0]} ${f[1]} ${fqdn(f[2])}`
      return null
    }
    case 'SOA':
      return f.length >= 7 ? [fqdn(f[0]), fqdn(f[1]), ...f.slice(2, 7)].join(' ') : null
    case 'TXT':
      return quoteTxt(c)
    default:
      return NAME_TYPES.has(type) ? fqdn(c) : c
  }
}

/**
 * @param {string} zone  zone name
 * @param {{name:string,type:string|null,content:string|null,ttl:number|null,prio:number|null,disabled:number|boolean|null}[]} rows
 * @returns {{zonefile:string, records:number, disabled:number, unusable:string[], apexNs:number, types:Record<string,number>}}
 *   disabled records are not copied (a zone file cannot express them, and they were not being served anyway)
 */
export function buildZoneFile(zone, rows) {
  const lines = [`$ORIGIN ${fqdn(zone)}`]
  const unusable = []
  let records = 0
  let disabled = 0
  let apexNs = 0
  const types = {}
  // SOA first, then the rest in a stable order so the same data always produces the same file
  const sorted = [...rows].sort((a, b) => Number(b.type === 'SOA') - Number(a.type === 'SOA') || strip(a.name).localeCompare(strip(b.name)) || String(a.type).localeCompare(String(b.type)))
  for (const r of sorted) {
    const type = String(r.type ?? '').toUpperCase()
    if (!type) continue // empty non-terminals have no type
    if (r.disabled) {
      disabled++
      continue
    }
    const data = rdata(type, r.content, r.prio)
    if (data === null) {
      unusable.push(`${strip(r.name)} ${type} ${String(r.content ?? '').slice(0, 60)}`.trim())
      continue
    }
    const ttl = r.ttl == null || r.ttl < 0 ? DEFAULT_TTL : r.ttl
    lines.push(`${fqdn(r.name)} ${ttl} IN ${type} ${data}`)
    records++
    types[type] = (types[type] ?? 0) + 1
    if (type === 'NS' && strip(r.name) === strip(zone)) apexNs++
  }
  return { zonefile: lines.join('\n') + '\n', records, disabled, unusable, apexNs, types }
}
