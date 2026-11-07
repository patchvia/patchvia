import { decodeQuery, encodeResponse, FormatError } from './codec.js'
import { EDNS_PAYLOAD, resolve, type ZoneLookup } from './resolver.js'
import type { Stats } from './stats.js'
import type { ResponseRateLimiter } from './rrl.js'
import { handleTransfer, type TransferPolicy } from './transfer.js'
import { OpCode, RClass, RCode, RType, type Response } from './types.js'

export type Transport = 'udp' | 'tcp'

/** Called for an incoming NOTIFY. Returns the RCODE to answer with (NOERROR accepts it). */
export type NotifyHandler = (zone: string, remote: string | undefined) => number

export interface HandlerContext {
  stats?: Stats
  transfers?: TransferPolicy
  notify?: NotifyHandler
  /** UDP response rate limiting */
  limiter?: ResponseRateLimiter
  /** Simultaneous TCP connections allowed per client address; 0 = unlimited */
  maxTcpPerIp?: number
}

/** Wire in, wire(s) out. An empty array means the packet must be silently dropped. AXFR yields several messages. */
export function handleMessages(
  zones: ZoneLookup,
  packet: Buffer,
  transport: Transport,
  remote?: string,
  ctx: HandlerContext = {},
): Buffer[] {
  let query
  try {
    query = decodeQuery(packet)
  } catch (err) {
    ctx.stats?.recordMalformed()
    if (!(err instanceof FormatError) || packet.length < 12) return []
    return [encodeResponse(formerr(packet.readUInt16BE(0)), 512)]
  }
  if (query.isResponse) return [] // never answer responses (reflection loops)

  const q = query.questions[0]

  if (query.opcode === OpCode.NOTIFY) {
    const res: Response = {
      id: query.id,
      opcode: OpCode.NOTIFY,
      aa: false,
      tc: false,
      rd: false,
      cd: false,
      rcode: RCode.NOTIMP,
      questions: query.questions,
      answers: [],
      authority: [],
      additional: [],
    }
    if (ctx.notify && q && query.questions.length === 1 && q.class === RClass.IN && q.type === RType.SOA) {
      res.rcode = ctx.notify(q.name, remote)
      res.aa = res.rcode === RCode.NOERROR
    }
    ctx.stats?.record(transport, res.rcode, q?.type)
    return [encodeResponse(res, 512)]
  }

  if (
    ctx.transfers &&
    query.opcode === OpCode.QUERY &&
    query.questions.length === 1 &&
    q &&
    q.class === RClass.IN &&
    (q.type === RType.AXFR || q.type === RType.IXFR)
  ) {
    const out = handleTransfer(ctx.transfers, query, transport, remote)
    ctx.stats?.record(transport, out[0] ? out[0][3]! & 0xf : RCode.SERVFAIL, q.type)
    return out
  }

  const res = resolve(zones, query)
  ctx.stats?.record(transport, res.rcode, q?.type)
  const max = transport === 'tcp' ? 65535 : Math.min(Math.max(query.edns?.payload ?? 512, 512), EDNS_PAYLOAD)

  if (transport === 'udp' && ctx.limiter?.enabled) {
    // Negative answers are bucketed per zone, so a random-subdomain flood shares one budget instead of many
    const key = res.rcode === RCode.NXDOMAIN ? `nx|${res.authority[0]?.name ?? ''}` : `${q?.name ?? ''}|${q?.type ?? 0}|${res.rcode}`
    const decision = ctx.limiter.check(remote, key)
    if (decision !== 'allow') {
      ctx.stats?.recordLimited(decision)
      if (decision === 'drop') return []
      // Truncated: an empty answer with TC set sends a genuine client to TCP and is no use to a spoofer
      return [encodeResponse({ ...res, answers: [], authority: [], additional: [], tc: true }, max)]
    }
  }
  return [encodeResponse(res, max)]
}

/** Single-response convenience used by tests and simple callers. */
export function handlePacket(zones: ZoneLookup, packet: Buffer, transport: Transport, stats?: Stats): Buffer | null {
  return handleMessages(zones, packet, transport, undefined, { stats })[0] ?? null
}

function formerr(id: number): Response {
  return {
    id,
    opcode: 0,
    aa: false,
    tc: false,
    rd: false,
    cd: false,
    rcode: RCode.FORMERR,
    questions: [],
    answers: [],
    authority: [],
    additional: [],
  }
}
