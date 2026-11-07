import { open, seal } from './secret-box';

export interface SessionData {
  /** Auth token for the API (never sent to the browser) */
  token: string;
  /** Absolute expiry, epoch ms */
  exp: number;
}

export function sealSession(data: SessionData, secret: string): string {
  return seal(JSON.stringify(data), secret, 'session');
}

export function openSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): SessionData | null {
  const json = open(value, secret, 'session');
  if (!json) return null;
  try {
    const data = JSON.parse(json) as SessionData;
    if (
      typeof data.token !== 'string' ||
      typeof data.exp !== 'number' ||
      data.exp <= now
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
