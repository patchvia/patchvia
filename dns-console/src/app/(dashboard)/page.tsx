import { Activity, AlertTriangle, Clock, Database, Globe2 } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BarBreakdown } from '@/components/charts/bar-breakdown';
import { StatTile } from '@/components/charts/stat-tile';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { describeAudit } from '@/lib/audit';
import {
  loadActivity,
  loadCluster,
  loadMe,
  loadStats,
  loadZones,
} from '@/lib/backend';
import { unhealthyPeers } from '@/lib/cluster-health';
import { compact, formatUptime, timeAgo } from '@/lib/format';
import { secondaryStatus } from '@/lib/zone-status';
import { withSession, withSessionOr } from '@/lib/with-session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const me = await withSession(loadMe);
  // Plain users only manage their own zones: the zone list is their dashboard
  if (me.role === 'user') redirect('/zones');

  const [stats, zones, activity, cluster] = await Promise.all([
    withSession(loadStats),
    withSession(loadZones),
    withSessionOr(loadActivity, []),
    me.role === 'admin'
      ? withSessionOr(loadCluster, { enabled: false as const })
      : Promise.resolve({ enabled: false as const }),
  ]);
  const downPeers = cluster.enabled ? unhealthyPeers(cluster.peers) : [];

  const failing = zones.filter((z) => secondaryStatus(z)?.tone === 'error');
  const records = zones.reduce((n, z) => n + z.recordCount, 0);
  const { total, udp, tcp, malformed } = stats.queries;
  const limited =
    (stats.rateLimited?.dropped ?? 0) + (stats.rateLimited?.truncated ?? 0);
  const qtypes = Object.entries(stats.qtypes).map(([label, value]) => ({
    label,
    value,
  }));
  const rcodes = Object.entries(stats.rcodes).map(([label, value]) => ({
    label,
    value,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Query counters since the server last started.
        </p>
      </div>

      {downPeers.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="font-medium">
              {downPeers.length} cluster node
              {downPeers.length === 1 ? ' is' : 's are'} not reachable
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {downPeers.map((p) => (
                <li key={p.address} className="break-words">
                  <Link
                    href="/cluster"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {p.nodeId ?? p.address}
                  </Link>
                  : {p.lastError}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {failing.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="font-medium">
              {failing.length} secondary zone
              {failing.length === 1 ? ' is' : 's are'} failing to transfer
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {failing.map((z) => (
                <li key={z.name} className="break-words">
                  <Link
                    href={`/zones/${z.name}/settings`}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {z.name}
                  </Link>
                  : {z.transferError}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Zones"
          value={compact(zones.length)}
          note="Served authoritatively"
          icon={Globe2}
        />
        <StatTile
          label="Records"
          value={compact(records)}
          note="Enabled records, excluding SOA"
          icon={Database}
        />
        <StatTile
          label="Queries answered"
          value={compact(total)}
          note={`${compact(udp)} UDP · ${compact(tcp)} TCP${malformed ? ` · ${compact(malformed)} malformed` : ''}${limited ? ` · ${compact(limited)} rate limited` : ''}`}
          icon={Activity}
        />
        <StatTile
          label="Uptime"
          value={formatUptime(stats.uptimeSeconds)}
          note={`Since ${new Date(stats.startedAt).toLocaleString('en-US')}`}
          icon={Clock}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BarBreakdown
          title="Query types"
          description="What resolvers are asking for"
          rows={qtypes}
          empty="No queries yet. Try: dig @your-server example.com"
        />
        <BarBreakdown
          title="Responses"
          description="NOERROR is a normal answer, including empty ones"
          rows={rcodes}
          highlight="NOERROR"
          empty="No queries yet."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent changes</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nothing has changed yet.
            </p>
          ) : (
            <ul className="divide-y">
              {activity.map((e) => {
                const v = describeAudit(e);
                return (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm"
                  >
                    <Badge
                      variant={
                        v.tone === 'create'
                          ? 'success'
                          : v.tone === 'delete'
                            ? 'destructive'
                            : 'default'
                      }
                    >
                      {v.tone === 'create'
                        ? 'Added'
                        : v.tone === 'delete'
                          ? 'Removed'
                          : 'Changed'}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      {v.title}
                      {e.zone && (
                        <>
                          {' in '}
                          {e.action === 'zone.delete' ? (
                            <span className="font-medium">{e.zone}</span>
                          ) : (
                            <Link
                              href={`/zones/${e.zone}`}
                              className="font-medium underline-offset-2 hover:underline"
                            >
                              {e.zone}
                            </Link>
                          )}
                        </>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {e.actor} · <time dateTime={e.at}>{timeAgo(e.at)}</time>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
