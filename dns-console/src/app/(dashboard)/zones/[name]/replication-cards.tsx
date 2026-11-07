'use client';

import { ArrowUpFromLine, Radio } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  notifyZoneAction,
  promoteZoneAction,
  setMastersAction,
} from '@/actions/zones';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { secondaryStatus } from '@/lib/zone-status';
import type { NotifyResult, ReplicationInfo, ZoneDetail } from '@/lib/types';
import { RetrieveButton } from './retrieve-button';

/** Primaries and transfer status of a secondary zone. */
export function SecondaryCard({ zone }: { zone: ZoneDetail }) {
  const router = useRouter();
  const [value, setValue] = useState(zone.masters.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [pending, startTransition] = useTransition();
  const status = secondaryStatus(zone);
  const list = value.split(/[\s,]+/).filter(Boolean);
  const dirty = list.join(',') !== zone.masters.join(',');

  function promote() {
    setError(null);
    startTransition(async () => {
      const res = await promoteZoneAction(zone.name);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPromoting(false);
      toast.success(`${zone.name} is now a primary zone`);
      router.refresh();
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await setMastersAction(zone.name, list);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success('Primaries updated, transferring…');
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Primary servers</CardTitle>
        <CardDescription>
          This zone is copied from these servers, tried in order. Each must
          allow this server to transfer the zone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <label htmlFor="masters" className="text-xs font-medium">
              Primaries (host or host:port)
            </label>
            <Input
              id="masters"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || pending || list.length === 0}
          >
            Save
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            {status && (
              <Badge
                variant={
                  status.tone === 'ok'
                    ? 'success'
                    : status.tone === 'error'
                      ? 'destructive'
                      : 'warning'
                }
              >
                {status.label}
              </Badge>
            )}
          </dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd>
            {zone.lastCheck
              ? new Date(zone.lastCheck).toLocaleString('en-US')
              : 'Never'}
          </dd>
          <dt className="text-muted-foreground">Last transfer</dt>
          <dd>
            {zone.lastTransfer
              ? new Date(zone.lastTransfer).toLocaleString('en-US')
              : 'Never'}
          </dd>
          {zone.transferError && (
            <>
              <dt className="text-muted-foreground">Last error</dt>
              <dd className="break-words text-destructive">
                {zone.transferError}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          <RetrieveButton zone={zone.name} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromoting(true)}
            disabled={status?.tone === 'pending'}
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" /> Promote to primary
          </Button>
        </div>
      </CardContent>

      <AlertDialog
        open={promoting}
        onOpenChange={(o) => !pending && setPromoting(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Promote {zone.name} to a primary zone?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This server stops copying the zone from {zone.masters.join(', ')}{' '}
              and keeps the {zone.recordCount} records it has. The zone becomes
              editable here. Do this when you are ready to switch the zone’s NS
              records to this server: from then on, changes made at the old
              primary no longer reach it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              Keep as secondary
            </AlertDialogCancel>
            <Button onClick={promote} disabled={pending}>
              {pending ? 'Promoting…' : 'Promote to primary'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** How secondaries connect to a primary or native zone, and a button to nudge them. */
export function ReplicationCard({
  zone,
  info,
  signed = false,
}: {
  zone: string;
  info: ReplicationInfo;
  signed?: boolean;
}) {
  const [results, setResults] = useState<NotifyResult[] | null>(null);
  const [pending, startTransition] = useTransition();
  const transfersOn = info.allowAxfrFrom.length > 0 && !signed;
  const cmd = `dig @your-server ${zone} AXFR`;

  function notify() {
    startTransition(async () => {
      const res = await notifyZoneAction(zone);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResults(res.data!);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Replication</CardTitle>
        <CardDescription>
          Secondary servers copy this zone by zone transfer (AXFR) and are told
          about changes with NOTIFY.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-1">
          <p className="font-medium">Zone transfers</p>
          {signed ? (
            <p className="text-muted-foreground">
              Off for this zone: it is signed with DNSSEC, which this server
              does online, so a secondary could not keep it signed.
            </p>
          ) : transfersOn ? (
            <p className="text-muted-foreground">
              Allowed from{' '}
              {info.allowAxfrFrom.map((a) => (
                <code
                  key={a}
                  className="mr-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                >
                  {a}
                </code>
              ))}
            </p>
          ) : (
            <p className="text-muted-foreground">
              Disabled. Set{' '}
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                ALLOW_AXFR_FROM
              </code>{' '}
              on the DNS server to the addresses or networks of your
              secondaries.
            </p>
          )}
          {transfersOn && (
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">
                {cmd}
              </code>
              <CopyButton value={cmd} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="font-medium">NOTIFY</p>
          {info.notifyTo.length === 0 ? (
            <p className="text-muted-foreground">
              No secondaries are configured. Set{' '}
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                NOTIFY_TO
              </code>{' '}
              on the DNS server to have them told about every change.
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {info.notifyTo.map((t) => {
                  const r = results?.find((x) => x.target === t);
                  return (
                    <li key={t} className="flex items-center gap-2">
                      <code className="font-mono text-xs">{t}</code>
                      {r && (
                        <Badge variant={r.acked ? 'success' : 'warning'}>
                          {r.acked ? 'Acknowledged' : 'No answer'}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={notify}
                  disabled={pending}
                >
                  <Radio className="h-3.5 w-3.5" />{' '}
                  {pending ? 'Sending…' : 'Send NOTIFY now'}
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
