export type Role = 'admin' | 'operator' | 'user';

export type RecordType =
  'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SRV' | 'TXT' | 'CAA' | 'SOA';

export interface RecordData {
  content: string;
  disabled: boolean;
}

export interface RRset {
  name: string;
  type: RecordType;
  ttl: number;
  records: RecordData[];
}

export type ZoneKind = 'native' | 'master' | 'slave';

export interface ZoneSummary {
  name: string;
  kind: ZoneKind;
  serial: number;
  recordCount: number;
  accountId: number | null;
  accountName: string | null;
  /** Secondary zones: the primaries transfers come from */
  masters: string[];
  lastCheck: string | null;
  lastTransfer: string | null;
  transferError: string | null;
  /** Signed with DNSSEC */
  dnssec: boolean;
}

export interface ZoneDetail extends Omit<ZoneSummary, 'accountName'> {
  rrsets: RRset[];
}

export interface User {
  id: number;
  username: string;
  role: Role;
  createdAt: string;
  accountIds: number[];
}

export interface Me extends User {
  via: 'session' | 'key';
  scope: 'full' | 'read' | 'write';
}

export interface Account {
  id: number;
  name: string;
  description: string;
  createdAt: string;
}

export interface ApiKey {
  id: number;
  userId: number;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  zone: string | null;
  action: string;
  detail: {
    name?: string;
    type?: RecordType;
    before?: { ttl: number; records: RecordData[] } | null;
    after?: { ttl: number; records: RecordData[] } | null;
    [k: string]: unknown;
  };
}

export interface ServerStats {
  startedAt: string;
  uptimeSeconds: number;
  queries: { total: number; udp: number; tcp: number; malformed: number };
  rateLimited?: { dropped: number; truncated: number };
  rcodes: Record<string, number>;
  qtypes: Record<string, number>;
  zones: number;
}

export interface RRsetChange {
  name: string;
  type: RecordType;
  changetype: 'REPLACE' | 'DELETE';
  ttl?: number;
  records?: RecordData[];
}

export interface ReplicationInfo {
  allowAxfrFrom: string[];
  notifyTo: string[];
  defaultNameservers: string[];
}

export interface ImportSummary {
  dryRun: boolean;
  ok: boolean;
  zone: string | null;
  mode: 'create' | 'replace';
  records: number;
  rrsets: number;
  byType: Record<string, number>;
  hasSoa: boolean;
  serial: number | null;
  skipped: Record<string, number>;
  warnings: string[];
  /** Number of records the zone has now, when replacing */
  replacing: number | null;
  problems: string[];
}

export interface TransferResult {
  updated: boolean;
  serial: number;
  records: number;
  skipped: Record<string, number>;
}

export interface NotifyResult {
  target: string;
  acked: boolean;
}

export interface DsRecord {
  keyTag: number;
  algorithm: number;
  digestType: 2 | 4;
  digest: string;
  /** "keytag algorithm digesttype digest": the form registrars ask for */
  text: string;
}

export interface DnssecKey {
  id: number;
  keyTag: number;
  algorithm: number;
  algorithmName: string;
  flags: number;
  role: 'CSK' | 'KSK' | 'ZSK';
  /** Signs the zone */
  active: boolean;
  /** In the zone's DNSKEY set */
  published: boolean;
  createdAt: string;
  dnskey: string;
  ds: DsRecord[];
}

export interface DnssecStatus {
  enabled: boolean;
  keys: DnssecKey[];
}

export interface DynToken {
  id: number;
  name: string;
  ttl: number;
  prefix: string;
  lastIp4: string | null;
  lastIp6: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ClusterPeer {
  address: string;
  nodeId: string | null;
  lastContact: string | null;
  lastError: string | null;
  lastSeq: number;
}

export type ClusterStatus =
  | { enabled: false }
  | {
      enabled: true;
      nodeId: string;
      hlc: string;
      entities: number;
      tombstones: number;
      seq: number;
      peers: ClusterPeer[];
      allowedAddresses: string[];
    };

export interface ClusterSyncResult {
  peer: string;
  ok: boolean;
  merged: number;
  error?: string;
}
