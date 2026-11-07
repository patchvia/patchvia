import { redirect } from 'next/navigation';
import { loadAccounts, loadMe, loadUsers } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { UsersPanel } from './users-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Users' };

export default async function UsersPage() {
  const me = await withSession(loadMe);
  if (me.role !== 'admin') redirect('/');
  const [users, accounts] = await Promise.all([
    withSession(loadUsers),
    withSession(loadAccounts),
  ]);
  return <UsersPanel users={users} accounts={accounts} meId={me.id} />;
}
