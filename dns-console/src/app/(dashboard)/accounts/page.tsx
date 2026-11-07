import { redirect } from 'next/navigation';
import { loadAccounts, loadMe, loadUsers, loadZones } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { AccountsPanel } from './accounts-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  const me = await withSession(loadMe);
  if (me.role !== 'admin') redirect('/');
  const [accounts, users, zones] = await Promise.all([
    withSession(loadAccounts),
    withSession(loadUsers),
    withSession(loadZones),
  ]);
  const stats = accounts.map((a) => ({
    ...a,
    members: users.filter(
      (u) => u.role === 'user' && u.accountIds.includes(a.id),
    ).length,
    zones: zones.filter((z) => z.accountId === a.id).length,
  }));
  return <AccountsPanel accounts={stats} />;
}
