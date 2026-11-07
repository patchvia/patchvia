import { notFound } from 'next/navigation';
import {
  BackendError,
  loadAccounts,
  loadDnssec,
  loadDynTokens,
  loadMe,
  loadReplication,
  loadZone,
  loadZones,
} from '@/lib/backend';
import { env } from '@/lib/env';
import { withSession, withSessionOr } from '@/lib/with-session';
import { DnssecCard } from '../dnssec-card';
import { DynDnsCard } from '../dyndns-card';
import { ReplicationCard, SecondaryCard } from '../replication-cards';
import { ZoneSettings } from './zone-settings';

export const dynamic = 'force-dynamic';

export default async function ZoneSettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const zoneName = decodeURIComponent(name);
  const me = await withSession(loadMe);
  const canManage = me.role !== 'user';
  try {
    const [zone, accounts, zones, replication] = await Promise.all([
      withSession((t) => loadZone(t, zoneName)),
      canManage ? withSessionOr(loadAccounts, []) : Promise.resolve([]),
      withSession(loadZones),
      canManage ? withSessionOr(loadReplication, null) : Promise.resolve(null),
    ]);
    const summary = zones.find((z) => z.name === zoneName);
    // Secondary zones are copies: they are signed by their primary and take no dynamic updates
    const editable = zone.kind !== 'slave';
    const [dnssec, dynTokens] = editable
      ? await Promise.all([
          withSession((t) => loadDnssec(t, zoneName)),
          withSessionOr((t) => loadDynTokens(t, zoneName), []),
        ])
      : [null, []];
    const apiUrl = env().DNS_PUBLIC_API_URL ?? env().DNS_API_URL;
    return (
      <div className="flex max-w-2xl flex-col gap-5">
        {canManage && zone.kind === 'slave' && <SecondaryCard zone={zone} />}
        {canManage && zone.kind !== 'slave' && replication && (
          <ReplicationCard
            zone={zone.name}
            info={replication}
            signed={dnssec?.enabled === true}
          />
        )}
        {dnssec && (
          <DnssecCard zone={zone.name} status={dnssec} canManage={canManage} />
        )}
        {editable && (
          <DynDnsCard zone={zone.name} tokens={dynTokens} apiUrl={apiUrl} />
        )}
        <ZoneSettings
          name={zone.name}
          kind={zone.kind}
          accountId={zone.accountId}
          accountName={summary?.accountName ?? null}
          accounts={accounts}
          canManage={canManage}
        />
      </div>
    );
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) notFound();
    throw e;
  }
}
