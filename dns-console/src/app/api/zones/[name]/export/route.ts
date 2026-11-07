import { NextResponse } from 'next/server';
import { BackendError, exportZone } from '@/lib/backend';
import { getSession } from '@/lib/session';

/** Streams the zone file through the console so the API token never reaches the browser. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await getSession();
  if (!session) return new NextResponse('Sign in required', { status: 401 });
  const { name } = await params;
  try {
    const text = await exportZone(session.token, decodeURIComponent(name));
    return new NextResponse(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${name.replace(/[^a-z0-9._-]/gi, '_')}.zone"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof BackendError)
      return new NextResponse(e.message, {
        status: e.status === 0 ? 502 : e.status,
      });
    throw e;
  }
}
