export const RType = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  DS: 43,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  OPT: 41,
  IXFR: 251,
  AXFR: 252,
  ANY: 255,
  CAA: 257,
} as const

export type RTypeName = 'A' | 'NS' | 'CNAME' | 'SOA' | 'PTR' | 'MX' | 'TXT' | 'AAAA' | 'SRV' | 'CAA'

/** Record types an operator may store in a zone. */
export const STORABLE_TYPES: readonly RTypeName[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']

export function typeNumber(name: string): number | undefined {
  const n = name.toUpperCase()
  return (STORABLE_TYPES as readonly string[]).includes(n) ? RType[n as RTypeName] : undefined
}

export function typeName(num: number): RTypeName | undefined {
  return STORABLE_TYPES.find((n) => RType[n] === num)
}

export const RCode = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
  NOTAUTH: 9,
  BADVERS: 16,
} as const

export const OpCode = { QUERY: 0, NOTIFY: 4 } as const

export const RClass = { IN: 1, ANY: 255 } as const

export interface Question {
  /** Lowercased, no trailing dot. */
  name: string
  /** As received on the wire (resolvers use 0x20 case randomisation and expect it echoed). */
  rawName: string
  type: number
  class: number
}

export interface Edns {
  payload: number
  version: number
  do: boolean
}

export interface Query {
  id: number
  opcode: number
  rd: boolean
  cd: boolean
  questions: Question[]
  edns?: Edns
  /** Client's serial from the authority section of an IXFR request */
  ixfrSerial?: number
}

/** Resource record with pre-encoded (uncompressed) rdata. */
export interface RR {
  name: string
  type: number
  ttl: number
  rdata: Buffer
}

export interface Response {
  id: number
  opcode: number
  aa: boolean
  tc: boolean
  rd: boolean
  cd: boolean
  rcode: number
  questions: Question[]
  answers: RR[]
  authority: RR[]
  additional: RR[]
  edns?: { payload: number; do?: boolean }
}
