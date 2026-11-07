import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/session';

/**
 * Where pages send you when the API rejects the token (expired, revoked, password changed elsewhere). Server
 * components cannot clear cookies, this route can. Without it the stale cookie would bounce /login and / forever.
 */
export async function GET(req: Request) {
  await destroySession();
  return NextResponse.redirect(new URL('/login', req.url));
}
