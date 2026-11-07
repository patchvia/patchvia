import 'server-only';
import { env } from './env';
import type {
  Account,
  ApiKey,
  AuditEntry,
  ClusterStatus,
  ClusterSyncResult,
  DnssecStatus,
  DynToken,
  Me,
  ReplicationInfo,
  ServerStats,
  User,
  ZoneDetail,
  ZoneSummary,
} from './types';

/** A failed call to the DNS API. `status` is the HTTP status, or 0 when it could not be reached. */
export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Whether the request carried a session token (a 401 on login just means a wrong password) */
    public authenticated = false,
  ) {
    super(message);
  }
  /** The token is missing, expired or revoked: the console must sign in again. */
  get isAuthFailure() {
    return this.status === 401 && this.authenticated;
  }
}

/** Calls the DNS API and returns its JSON (204 → undefined, text/plain → string). */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env().DNS_API_URL}/v1/${path.replace(/^\/+/, '')}`, {
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers: {
        ...(init.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error('Failed to reach the DNS API', error);
    throw new BackendError(0, 'Cannot reach the DNS server');
  }
  if (res.status === 204) return undefined as T;
  const text = res.headers.get('content-type')?.startsWith('text/plain');
  const body = text
    ? await res.text()
    : ((await res.json().catch(() => null)) as unknown);
  if (!res.ok) {
    const message = (body as { message?: string } | null)?.message;
    throw new BackendError(
      res.status,
      message ?? `The API returned HTTP ${res.status}`,
      !!init.token,
    );
  }
  return body as T;
}

export const login = (username: string, password: string) =>
  api<{ token: string; expiresInHours: number; user: User }>('auth/login', {
    method: 'POST',
    body: { username, password },
  });

export const loadMe = (token: string) => api<Me>('auth/me', { token });
export const loadZones = (token: string) =>
  api<ZoneSummary[]>('zones', { token });
export const loadZone = (token: string, name: string) =>
  api<ZoneDetail>(`zones/${encodeURIComponent(name)}`, { token });
export const loadHistory = (token: string, name: string, limit = 100) =>
  api<AuditEntry[]>(
    `zones/${encodeURIComponent(name)}/history?limit=${limit}`,
    { token },
  );
export const loadActivity = (token: string, limit = 12) =>
  api<AuditEntry[]>(`server/activity?limit=${limit}`, { token });
export const loadStats = (token: string) =>
  api<ServerStats>('server/stats', { token });
export const loadUsers = (token: string) => api<User[]>('users', { token });
export const loadAccounts = (token: string) =>
  api<Account[]>('accounts', { token });
export const loadApiKeys = (token: string) =>
  api<ApiKey[]>('api-keys', { token });
export const exportZone = (token: string, name: string) =>
  api<string>(`zones/${encodeURIComponent(name)}/export`, { token });
export const loadReplication = (token: string) =>
  api<ReplicationInfo>('server/replication', { token });
export const loadDnssec = (token: string, zone: string) =>
  api<DnssecStatus>(`zones/${encodeURIComponent(zone)}/dnssec`, { token });
export const loadDynTokens = (token: string, zone: string) =>
  api<DynToken[]>(`zones/${encodeURIComponent(zone)}/dyndns`, { token });
export const loadCluster = (token: string) =>
  api<ClusterStatus>('cluster', { token });
export const syncCluster = (token: string) =>
  api<{ results: ClusterSyncResult[] }>('cluster/sync', {
    method: 'POST',
    token,
  });
