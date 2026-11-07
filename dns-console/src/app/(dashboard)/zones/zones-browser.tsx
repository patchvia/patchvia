'use client';

import { FileUp, Globe2, Plus, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { compact } from '@/lib/format';
import { secondaryStatus } from '@/lib/zone-status';
import { cn } from '@/lib/utils';
import type { Account, ZoneSummary } from '@/lib/types';
import { ImportZoneDialog } from './import-zone-dialog';
import { NewZoneDialog } from './new-zone-dialog';

export function ZonesBrowser({
  zones,
  accounts,
  canManage,
}: {
  zones: ZoneSummary[];
  accounts: Account[];
  canManage: boolean;
}) {
  const params = useSearchParams();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(
    params.get('new') === '1' && canManage,
  );
  const [importing, setImporting] = useState(
    params.get('import') === '1' && canManage,
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? zones.filter((z) =>
          `${z.name} ${z.accountName ?? ''}`.toLowerCase().includes(q),
        )
      : zones;
  }, [zones, query]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Zones</h1>
          <p className="text-sm text-muted-foreground">
            {zones.length === 0
              ? 'No zones yet'
              : `${zones.length} zone${zones.length === 1 ? '' : 's'} served`}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImporting(true)}
            >
              <FileUp className="h-4 w-4" /> Import
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New zone
            </Button>
          </div>
        )}
      </div>

      {zones.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter zones…"
            aria-label="Filter zones"
            className="pl-9"
          />
        </div>
      )}

      {zones.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Globe2 className="h-8 w-8 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">
              {canManage
                ? 'Create your first zone'
                : 'No zones are assigned to you'}
            </p>
            <p className="text-sm text-muted-foreground">
              {canManage
                ? 'A zone holds all the DNS records for one domain.'
                : 'Ask an administrator to give your account access to a zone.'}
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New zone
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_9rem] gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Zone</span>
            <span className="text-right">Records</span>
            <span className="text-right">Serial</span>
            <span>Account</span>
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No zone matches “{query}”.
            </p>
          ) : (
            <ul className="divide-y">
              {visible.map((z) => (
                <li key={z.name}>
                  <Link
                    href={`/zones/${z.name}`}
                    className="grid items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-secondary/50 md:grid-cols-[minmax(0,1fr)_6rem_8rem_9rem]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{z.name}</span>
                      {z.kind === 'slave' ? (
                        <SecondaryBadge zone={z} />
                      ) : (
                        z.kind === 'master' && <Badge>Primary</Badge>
                      )}
                      {z.dnssec && (
                        <Badge variant="success" title="Signed with DNSSEC">
                          <ShieldCheck className="mr-1 h-3 w-3" aria-hidden />
                          DNSSEC
                        </Badge>
                      )}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground md:text-right">
                      {compact(z.recordCount)}{' '}
                      <span className="md:hidden">records</span>
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground md:text-right">
                      <span className="md:hidden">Serial </span>
                      {z.serial}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      {z.accountName ?? '—'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && (
        <NewZoneDialog
          open={creating}
          onOpenChange={setCreating}
          accounts={accounts}
        />
      )}
      {canManage && (
        <ImportZoneDialog
          open={importing}
          onOpenChange={setImporting}
          zones={zones}
          accounts={accounts}
        />
      )}
    </div>
  );
}

function SecondaryBadge({ zone }: { zone: ZoneSummary }) {
  const status = secondaryStatus(zone);
  return (
    <>
      <Badge>Secondary</Badge>
      {status && status.tone !== 'ok' && (
        <Badge
          variant={status.tone === 'error' ? 'destructive' : 'warning'}
          className={cn('truncate')}
          title={status.detail}
        >
          {status.label}
        </Badge>
      )}
    </>
  );
}
