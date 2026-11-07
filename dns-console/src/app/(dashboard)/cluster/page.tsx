import { redirect } from 'next/navigation';
import { loadCluster, loadMe } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { ClusterPanel } from './cluster-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cluster' };

export default async function ClusterPage() {
  const me = await withSession(loadMe);
  if (me.role !== 'admin') redirect('/');
  const status = await withSession(loadCluster);
  return <ClusterPanel status={status} />;
}
