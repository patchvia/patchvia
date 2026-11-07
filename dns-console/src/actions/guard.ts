import 'server-only';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { BackendError } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

/** An expected, user-facing failure (shown as-is in the UI). */
export class UserError extends Error {}

export type ActionResult<T = void> =
  { ok: true; data?: T } | { ok: false; error: string };

/** Runs an API operation as the signed-in user; bounces to /login if the session is gone. */
export async function asUser<T>(
  fn: (token: string) => Promise<T>,
): Promise<ActionResult<T>> {
  const session = await getSession();
  if (!session) redirect('/login');
  try {
    return { ok: true, data: await fn(session.token) };
  } catch (e) {
    if (e instanceof BackendError) {
      if (e.isAuthFailure) {
        console.warn(
          `Session rejected by the API (HTTP ${e.status}): ${e.message}`,
        );
        await destroySession();
        redirect('/login');
      }
      return { ok: false, error: e.message };
    }
    if (e instanceof UserError) return { ok: false, error: e.message };
    if (e instanceof ZodError)
      return { ok: false, error: e.issues[0]?.message ?? 'Invalid input' };
    throw e; // includes Next's redirect/notFound signals
  }
}
