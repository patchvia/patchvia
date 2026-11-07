import { RCode, RType, typeName } from './types.js'

const RCODE_NAMES = Object.fromEntries(Object.entries(RCode).map(([k, v]) => [v, k])) as Record<number, string>

/** Cheap in-memory counters for the stats endpoint. */
export class Stats {
  readonly startedAt = Date.now()
  private total = 0
  private byTransport = { udp: 0, tcp: 0 }
  private byRcode = new Map<string, number>()
  private byType = new Map<string, number>()
  private malformed = 0
  private limited = { dropped: 0, truncated: 0 }

  record(transport: 'udp' | 'tcp', rcode: number, qtype: number | undefined): void {
    this.total++
    this.byTransport[transport]++
    const rc = RCODE_NAMES[rcode] ?? String(rcode)
    this.byRcode.set(rc, (this.byRcode.get(rc) ?? 0) + 1)
    if (qtype !== undefined) {
      const t = typeName(qtype) ?? (Object.entries(RType).find(([, v]) => v === qtype)?.[0] ?? `TYPE${qtype}`)
      this.byType.set(t, (this.byType.get(t) ?? 0) + 1)
    }
  }

  recordMalformed(): void {
    this.malformed++
  }

  recordLimited(action: 'drop' | 'truncate'): void {
    if (action === 'drop') this.limited.dropped++
    else this.limited.truncated++
  }

  snapshot() {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      queries: { total: this.total, ...this.byTransport, malformed: this.malformed },
      rateLimited: { ...this.limited },
      rcodes: Object.fromEntries(this.byRcode),
      qtypes: Object.fromEntries(this.byType),
    }
  }
}

export interface MetricsInput {
  stats: ReturnType<Stats['snapshot']>
  zones: number
  records: number
  dnssecZones: number
  secondaryZones: number
  secondaryFailing: number
  /** Present only in cluster mode */
  cluster?: { peersConnected: number; peersFailing: number; peersJoining: number }
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** Prometheus text exposition format (version 0.0.4). */
export function renderMetrics(m: MetricsInput): string {
  const out: string[] = []
  const metric = (name: string, help: string, type: 'counter' | 'gauge', rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, v] of rows) {
      const l = Object.entries(labels)
        .map(([k, x]) => `${k}="${esc(x)}"`)
        .join(',')
      out.push(`${name}${l ? `{${l}}` : ''} ${v}`)
    }
  }
  const q = m.stats.queries
  metric('dns_queries_total', 'DNS queries answered, by transport.', 'counter', [
    [{ transport: 'udp' }, q.udp],
    [{ transport: 'tcp' }, q.tcp],
  ])
  metric('dns_responses_total', 'DNS responses, by response code.', 'counter', Object.entries(m.stats.rcodes).map(([k, v]) => [{ rcode: k }, v]))
  metric('dns_queries_by_type_total', 'DNS queries, by question type.', 'counter', Object.entries(m.stats.qtypes).map(([k, v]) => [{ qtype: k }, v]))
  metric('dns_malformed_packets_total', 'Packets that could not be parsed.', 'counter', [[{}, q.malformed]])
  metric('dns_rate_limited_total', 'UDP responses held back by response rate limiting.', 'counter', [
    [{ action: 'dropped' }, m.stats.rateLimited.dropped],
    [{ action: 'truncated' }, m.stats.rateLimited.truncated],
  ])
  metric('dns_zones', 'Zones served.', 'gauge', [[{}, m.zones]])
  metric('dns_records', 'Enabled records across all zones, excluding SOA.', 'gauge', [[{}, m.records]])
  metric('dns_dnssec_zones', 'Zones signed with DNSSEC.', 'gauge', [[{}, m.dnssecZones]])
  metric('dns_secondary_zones', 'Secondary zones, and how many are failing to transfer.', 'gauge', [
    [{ state: 'total' }, m.secondaryZones],
    [{ state: 'failing' }, m.secondaryFailing],
  ])
  if (m.cluster) {
    metric('dns_cluster_peers', 'Cluster peers, by state.', 'gauge', [
      [{ state: 'connected' }, m.cluster.peersConnected],
      [{ state: 'failing' }, m.cluster.peersFailing],
      [{ state: 'joining' }, m.cluster.peersJoining],
    ])
  }
  metric('dns_uptime_seconds', 'Seconds since the server started.', 'gauge', [[{}, m.stats.uptimeSeconds]])
  return out.join('\n') + '\n'
}
