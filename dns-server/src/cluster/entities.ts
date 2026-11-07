import { createHash } from 'node:crypto'

/**
 * What the cluster replicates. Each entity has a natural key (never a database id, which differs per node) and a JSON
 * payload; merging is last-writer-wins per key using hybrid logical clock stamps, with deletions kept as tombstones.
 */
export type EntityKind = 'zone' | 'rrset' | 'account' | 'user' | 'apikey' | 'ddns' | 'dnssec'

export const ENTITY_KINDS: readonly EntityKind[] = ['zone', 'rrset', 'account', 'user', 'apikey', 'ddns', 'dnssec']

export const key = {
  zone: (name: string) => `zone:${name}`,
  rrset: (zone: string, name: string, type: string) => `rrset:${zone}|${name}|${type}`,
  account: (name: string) => `account:${name}`,
  user: (username: string) => `user:${username}`,
  apikey: (hash: string) => `apikey:${hash}`,
  ddns: (zone: string, name: string) => `ddns:${zone}|${name}`,
  dnssec: (zone: string, keyTag: number) => `dnssec:${zone}|${keyTag}`,
}

export function kindOf(k: string): EntityKind | undefined {
  const kind = k.slice(0, k.indexOf(':')) as EntityKind
  return ENTITY_KINDS.includes(kind) ? kind : undefined
}

/** The zone an entity belongs to, for the kinds that live inside a zone. */
export function zoneOf(k: string): string | undefined {
  const kind = kindOf(k)
  const rest = k.slice(k.indexOf(':') + 1)
  if (kind === 'zone') return rest
  if (kind === 'rrset' || kind === 'ddns' || kind === 'dnssec') return rest.split('|')[0]
  return undefined
}

/** Small kinds are cheap enough to compare in full on every sync; rrsets are the only bulk. */
export const isBulk = (k: string) => kindOf(k) === 'rrset'

/** Stable serialisation (sorted keys) so equal payloads always hash equal, whatever order they were built in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const hashOf = (json: string) => createHash('sha256').update(json).digest('hex')

/** SOA serials are per node (they must rise on every change a node serves), so they are not part of what is replicated. */
export const normalizeSoa = (content: string): string => {
  const p = content.trim().split(/\s+/)
  p[2] = '0'
  return p.join(' ')
}

export const withSoaSerial = (content: string, serial: number): string => {
  const p = content.trim().split(/\s+/)
  p[2] = String(serial)
  return p.join(' ')
}

export interface WireEntity {
  key: string
  hlc: string
  deleted: boolean
  payload: string
  seq: number
}

export interface StoredEntity extends WireEntity {
  kind: EntityKind
  hash: string
  live: boolean
}

export const TOMBSTONE_PAYLOAD = '{}'
