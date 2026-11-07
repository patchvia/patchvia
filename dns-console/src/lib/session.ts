import 'server-only';
import { cookies, headers } from 'next/headers';
import { env } from './env';
import { openSession, sealSession } from './session-crypto';

export const SESSION_COOKIE = 'dns_console_session';

export async function getSession() {
  const store = await cookies();
  return openSession(store.get(SESSION_COOKIE)?.value, env().SESSION_SECRET);
}

export async function createSession(token: string) {
  const hours = env().SESSION_HOURS;
  const exp = Date.now() + hours * 3600_000;
  const store = await cookies();
  // Secure whenever the browser reached us over HTTPS (directly or via a proxy); plain http://localhost still works
  const h = await headers();
  const host = h.get('host') ?? '';
  const proto =
    h.get('x-forwarded-proto') ??
    (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  store.set(SESSION_COOKIE, sealSession({ token, exp }, env().SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    path: '/',
    maxAge: hours * 3600,
  });
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}
