import { loadAccounts, loadMe, loadZones } from '@/lib/backend';
import { withSession, withSessionOr } from '@/lib/with-session';
import { ZonesBrowser } from './zones-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Zones' };

export default async function ZonesPage() {
  const me = await withSession(loadMe);
  const canManage = me.role !== 'user';
  const [zones, accounts] = await Promise.all([
    withSession(loadZones),
    canManage ? withSessionOr(loadAccounts, []) : Promise.resolve([]),
  ]);
  return (
    <ZonesBrowser zones={zones} accounts={accounts} canManage={canManage} />
  );
}
