import type { StoredRRset } from './zone-repository.js'

const dot = (n: string) => (n === '' ? '.' : `${n}.`)

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Stored content (names without trailing dot) to RFC 1035 presentation format. */
export function presentContent(type: string, content: string): string {
  const parts = content.trim().split(/\s+/)
  switch (type) {
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return dot(parts[0] ?? '')
    case 'MX':
      return `${parts[0]} ${dot(parts[1] ?? '')}`
    case 'SRV':
      return `${parts[0]} ${parts[1]} ${parts[2]} ${dot(parts[3] ?? '')}`
    case 'SOA':
      return [dot(parts[0] ?? ''), dot(parts[1] ?? ''), ...parts.slice(2)].join(' ')
    case 'TXT':
      return content.trim().startsWith('"') ? content.trim() : quote(content)
    case 'CAA': {
      const m = /^(\d+)\s+(\S+)\s+(.*)$/s.exec(content.trim())
      if (!m) return content
      const v = m[3]!.trim()
      return `${m[1]} ${m[2]} ${v.startsWith('"') ? v : quote(v)}`
    }
    default:
      return content.trim()
  }
}

/** BIND-style zone file. SOA first, then apex NS, then everything else sorted. Disabled records are commented out. */
export function exportZoneFile(apex: string, rrsets: StoredRRset[]): string {
  const rank = (s: StoredRRset) => (s.name === apex && s.type === 'SOA' ? 0 : s.name === apex && s.type === 'NS' ? 1 : 2)
  const sorted = [...rrsets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
  const lines = [`$ORIGIN ${dot(apex)}`]
  for (const s of sorted) {
    for (const r of s.records) {
      const line = `${dot(s.name)}\t${s.ttl}\tIN\t${s.type}\t${presentContent(s.type, r.content)}`
      lines.push(r.disabled ? `; ${line}` : line)
    }
  }
  return lines.join('\n') + '\n'
}
