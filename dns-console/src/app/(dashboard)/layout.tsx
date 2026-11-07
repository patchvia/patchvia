import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { loadMe, loadZones } from '@/lib/backend';
import { getSession } from '@/lib/session';
import { withSession, withSessionOr } from '@/lib/with-session';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Real URLs + a server-side session check: a refresh keeps you signed in, and an expired session redirects
  // to /login instead of rendering a broken page.
  const session = await getSession();
  if (!session) redirect('/login');
  // The first call also notices a dead token (revoked, password changed): sign out cleanly
  const me = await withSession(loadMe);
  // Zone names feed the command palette; without them it just lists pages
  const zones = await withSessionOr(loadZones, []);

  return (
    <AppShell
      user={{ username: me.username, role: me.role }}
      zones={zones.map((z) => z.name).sort()}
    >
      {children}
    </AppShell>
  );
}
