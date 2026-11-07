import 'server-only';
import { redirect } from 'next/navigation';
import { BackendError } from './backend';
import { getSession } from './session';

export const SESSION_EXPIRED_PATH = '/api/session/expired';

/** For server components: turns a rejected token into a clean sign-out instead of an error page. */
export function redirectIfSessionExpired(error: unknown): void {
  if (error instanceof BackendError && error.isAuthFailure) {
    // Worth knowing in production: why was a signed-in user sent back to the login page?
    console.warn(
      `Session rejected by the API (HTTP ${error.status}): ${error.message}`,
    );
    redirect(SESSION_EXPIRED_PATH);
  }
}

/** Runs an API call as the signed-in user from a server component. */
export async function withSession<T>(
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const session = await getSession();
  if (!session) redirect('/login');
  try {
    return await fn(session.token);
  } catch (e) {
    redirectIfSessionExpired(e);
    throw e;
  }
}

/** True for the control-flow errors Next throws from redirect() and notFound(): they must never be swallowed. */
function isNextControlFlow(e: unknown) {
  const digest = (e as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') ||
      digest.startsWith('NEXT_HTTP_ERROR_FALLBACK'))
  );
}

/** Like withSession, but a failure other than "signed out" gives `fallback`. For optional extras. */
export async function withSessionOr<T>(
  fn: (token: string) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await withSession(fn);
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    return fallback;
  }
}
