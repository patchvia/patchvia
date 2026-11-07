import { hostname } from 'node:os'
import { parsePeerAddress } from '../cluster/peer-address.js'
import { compileAcl } from '../common/cidr.js'
import { parseTarget } from '../replication/target.js'

export interface Config {
  dnsHost: string
  dnsPort: number
  apiHost: string
  apiPort: number
  dbPath: string
  /** Optional: when unset a random secret is generated once and kept in the database. */
  jwtSecret?: string
  /** First-boot admin password. When unset one is generated and logged once. */
  adminPassword?: string
  sessionHours: number
  /** Used when a zone is created without explicit nameservers. */
  defaultNameservers: string[]
  /** Addresses or CIDR networks allowed to AXFR/IXFR zones. Empty disables transfers. */
  allowAxfrFrom: string[]
  /** Secondaries that receive a NOTIFY when a zone changes ("host" or "host:port") */
  notifyTo: string[]
  /** Identical UDP responses allowed per second per client network; 0 turns rate limiting off */
  rrlResponsesPerSecond: number
  rrlSlip: number
  /** Clients never rate limited (CIDRs) */
  rrlExempt: string[]
  /** Simultaneous TCP connections per client address */
  tcpMaxPerIp: number
  /** Cluster sync. Enabled when a secret is set. */
  clusterSecret?: string
  clusterNodeId: string
  /** The other nodes' API addresses: "host", "host:port" or "https://host:port" */
  clusterPeers: string[]
  /** Extra source addresses (CIDR) allowed to talk to the cluster endpoints, besides the peers' own addresses */
  clusterAllowFrom: string[]
  clusterSyncSeconds: number
}

export const CONFIG = 'CONFIG'

const list = (v: string | undefined) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

function port(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${key} must be a port number, got "${value}"`)
  return n
}

function nonNegative(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a whole number of 0 or more, got "${value}"`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = buildConfig(env)
  try {
    compileAcl(cfg.allowAxfrFrom)
    compileAcl(cfg.rrlExempt)
  } catch (e) {
    throw new Error(`ALLOW_AXFR_FROM: ${(e as Error).message}`)
  }
  if (cfg.clusterSecret && cfg.clusterSecret.length < 32) throw new Error('CLUSTER_SECRET must be at least 32 characters')
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(cfg.clusterNodeId)) throw new Error(`CLUSTER_NODE_ID "${cfg.clusterNodeId}" must be letters, digits, dot, dash or underscore`)
  if (cfg.clusterPeers.length > 0 && !cfg.clusterSecret) throw new Error('CLUSTER_PEERS is set but CLUSTER_SECRET is not')
  try {
    compileAcl(cfg.clusterAllowFrom)
  } catch (e) {
    throw new Error(`CLUSTER_ALLOW_FROM: ${(e as Error).message}`)
  }
  for (const peer of cfg.clusterPeers) {
    try {
      parsePeerAddress(peer, cfg.apiPort)
    } catch (e) {
      throw new Error(`CLUSTER_PEERS: ${(e as Error).message}`)
    }
  }
  for (const t of cfg.notifyTo) {
    try {
      parseTarget(t)
    } catch (e) {
      throw new Error(`NOTIFY_TO: ${(e as Error).message}`)
    }
  }
  return cfg
}

function buildConfig(env: NodeJS.ProcessEnv): Config {
  const hours = Number(env.SESSION_HOURS || 12)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('SESSION_HOURS must be a positive number')
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
  return {
    dnsHost: env.DNS_HOST || '::',
    dnsPort: port(env.DNS_PORT, 53, 'DNS_PORT'),
    apiHost: env.API_HOST || '0.0.0.0',
    apiPort: port(env.API_PORT, 8081, 'API_PORT'),
    dbPath: env.DB_PATH || './data/dns.db',
    jwtSecret: env.JWT_SECRET || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    sessionHours: hours,
    defaultNameservers: list(env.DEFAULT_NS),
    allowAxfrFrom: list(env.ALLOW_AXFR_FROM),
    notifyTo: list(env.NOTIFY_TO),
    rrlResponsesPerSecond: nonNegative(env.RRL_RESPONSES_PER_SECOND, 20, 'RRL_RESPONSES_PER_SECOND'),
    rrlSlip: nonNegative(env.RRL_SLIP, 2, 'RRL_SLIP'),
    rrlExempt: env.RRL_EXEMPT === undefined ? ['127.0.0.1', '::1'] : list(env.RRL_EXEMPT),
    tcpMaxPerIp: nonNegative(env.TCP_MAX_PER_IP, 50, 'TCP_MAX_PER_IP'),
    clusterSecret: env.CLUSTER_SECRET || undefined,
    clusterNodeId: (env.CLUSTER_NODE_ID || hostname()).toLowerCase(),
    clusterPeers: list(env.CLUSTER_PEERS),
    clusterAllowFrom: list(env.CLUSTER_ALLOW_FROM),
    clusterSyncSeconds: Math.max(1, nonNegative(env.CLUSTER_SYNC_SECONDS, 10, 'CLUSTER_SYNC_SECONDS')),
  }
}
