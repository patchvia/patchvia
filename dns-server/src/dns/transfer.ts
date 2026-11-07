import { compareZoneOrder } from '../zones/order.js'
import type { ZoneIndex } from '../zones/zone-index.js'
import { serialGt } from '../zones/serial.js'
import type { Zone } from '../zones/zone.js'
import { encodeResponse } from './codec.js'
import { RCode, RType, type Query, type Response, type RR } from './types.js'

export interface TransferPolicy {
  /** Whether this client address may transfer zones at all */
  allow(remote: string | undefined): boolean
  /** The zone whose apex is exactly `name` */
  zone(name: string): Zone | undefined
}

/** Keep each DNS message well under 64 KB even before name compression helps. */
const MESSAGE_BUDGET = 30_000

function base(query: Query, over: Partial<Response>): Response {
  return {
    id: query.id,
    opcode: 0,
    aa: true,
    tc: false,
    rd: query.rd,
    cd: false,
    rcode: RCode.NOERROR,
    questions: query.questions,
    answers: [],
    authority: [],
    additional: [],
    ...over,
  }
}

function soaRR(zone: Zone): RR {
  return { name: zone.apex, type: RType.SOA, ttl: zone.soa.ttl, rdata: zone.soa.rdatas[0]!.wire }
}

/**
 * AXFR (RFC 5936) and IXFR-as-AXFR (RFC 1995 section 4: a server may answer an IXFR with a full transfer).
 * AXFR is TCP only. Returns the wire messages to send, in order.
 */
export function handleTransfer(policy: TransferPolicy, query: Query, transport: 'udp' | 'tcp', remote: string | undefined): Buffer[] {
  const q = query.questions[0]!
  const refuse = () => [encodeResponse(base(query, { rcode: RCode.REFUSED, aa: false }), 512)]

  if (!policy.allow(remote)) return refuse()
  const zone = policy.zone(q.name)
  if (!zone) return refuse()

  if (q.type === RType.IXFR && query.ixfrSerial !== undefined && !serialGt(zone.serial, query.ixfrSerial)) {
    // The client is current: a lone SOA says so
    return [encodeResponse(base(query, { answers: [soaRR(zone)] }), 65535)]
  }
  if (transport === 'udp') {
    // Never stream over UDP. For IXFR a truncated reply makes the client retry over TCP; AXFR is simply refused
    if (q.type === RType.IXFR) return [encodeResponse(base(query, { answers: [soaRR(zone)], tc: true }), 512)]
    return refuse()
  }

  const soa = soaRR(zone)
  const rest: RR[] = []
  const sets = zone.allRRsets().filter((s) => !(s.name === zone.apex && s.type === RType.SOA))
  sets.sort((a, b) => compareZoneOrder(a, b, zone.apex))
  for (const s of sets) for (const r of s.rdatas) rest.push({ name: s.name, type: s.type, ttl: s.ttl, rdata: r.wire })

  const messages: Buffer[] = []
  let chunk: RR[] = [soa]
  let size = soa.name.length + 10 + soa.rdata.length
  const flush = () => {
    messages.push(encodeResponse(base(query, { questions: messages.length === 0 ? query.questions : [], answers: chunk }), 65535))
    chunk = []
    size = 0
  }
  for (const rr of [...rest, soa]) {
    const cost = rr.name.length + 10 + rr.rdata.length
    if (chunk.length > 0 && size + cost > MESSAGE_BUDGET) flush()
    chunk.push(rr)
    size += cost
  }
  if (chunk.length > 0) flush()
  return messages
}

/**
 * Who may transfer what. Signed zones are never transferred: they are signed online by this server alone, so a
 * secondary would receive unsigned data (or signatures it cannot renew) and break validation for its clients.
 */
export function transferPolicy(index: Pick<ZoneIndex, 'get'>, allow: (remote: string | undefined) => boolean): TransferPolicy {
  return {
    allow,
    zone: (name) => {
      const z = index.get(name)
      return z && z.apex === name && !z.signed ? z : undefined
    },
  }
}
