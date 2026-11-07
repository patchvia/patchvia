import { notFound } from 'next/navigation';
import { BackendError, loadMe, loadZone } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { RecordEditor } from './record-editor';
import { SecondaryBanner } from './secondary-banner';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  return { title: decodeURIComponent((await params).name) };
}

export default async function ZoneRecordsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  try {
    const [zone, me] = await Promise.all([
      withSession((token) => loadZone(token, decodeURIComponent(name))),
      withSession(loadMe),
    ]);
    const readOnly = zone.kind === 'slave';
    return (
      <div className="flex flex-col gap-4">
        <SecondaryBanner zone={zone} canManage={me.role !== 'user'} />
        <RecordEditor zone={zone} readOnly={readOnly} />
      </div>
    );
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) notFound();
    throw e;
  }
}
