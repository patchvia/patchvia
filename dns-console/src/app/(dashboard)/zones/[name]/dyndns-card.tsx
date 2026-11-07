'use client';

import { Plus, Radio, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createDynTokenAction, deleteDynTokenAction } from '@/actions/dyndns';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { dynSnippets } from '@/lib/dyndns-snippets';
import { timeAgo } from '@/lib/format';
import { displayName, formatTtl, nameError, toFqdn } from '@/lib/records';
import type { DynToken } from '@/lib/types';

const TTLS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
];

interface Created {
  fqdn: string;
  token: string;
}

export function DynDnsCard({
  zone,
  tokens,
  apiUrl,
}: {
  zone: string;
  tokens: DynToken[];
  apiUrl: string;
}) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState('60');
  const [created, setCreated] = useState<Created | null>(null);
  const [revoking, setRevoking] = useState<DynToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fqdn = toFqdn(label, zone);
  const invalid = label.trim() ? nameError(fqdn) : null;

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || invalid) return;
    setError(null);
    startTransition(async () => {
      const res = await createDynTokenAction(zone, {
        name: fqdn,
        ttl: Number(ttl),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreated({ fqdn: res.data!.name, token: res.data!.token });
      setLabel('');
      router.refresh();
    });
  }

  function revoke() {
    if (!revoking) return;
    startTransition(async () => {
      const res = await deleteDynTokenAction(zone, revoking.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Revoked the token for ${displayName(revoking.name, zone)}`,
      );
      if (created?.fqdn === revoking.name) setCreated(null);
      setRevoking(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" aria-hidden />{' '}
          Dynamic DNS
        </CardTitle>
        <CardDescription>
          Keep a hostname pointed at a changing address, such as a home
          connection. Each token can update one name and nothing else.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor="dyn-name" className="text-xs font-medium">
              Hostname
            </label>
            <div className="flex">
              <Input
                id="dyn-name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="home"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                autoCapitalize="none"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-r-none"
              />
              <span className="flex max-w-[55%] shrink-0 items-center truncate rounded-r-md border border-l-0 bg-muted px-2.5 text-xs text-muted-foreground">
                .{zone}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="dyn-ttl" className="text-xs font-medium">
              TTL
            </label>
            <Select value={ttl} onValueChange={setTtl}>
              <SelectTrigger id="dyn-ttl" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TTLS.map((t) => (
                  <SelectItem key={t.value} value={String(t.value)}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !label.trim() || !!invalid}
          >
            <Plus className="h-4 w-4" /> Create token
          </Button>
        </form>
        {invalid && (
          <p role="alert" className="text-xs text-destructive">
            {invalid}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        {created && <CreatedPanel created={created} apiUrl={apiUrl} />}

        {tokens.length === 0 ? (
          <p className="py-2 text-center text-muted-foreground">
            No dynamic hostnames yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="text-xs text-muted-foreground">
                    TTL {formatTtl(t.ttl)} ·{' '}
                    {[t.lastIp4, t.lastIp6].filter(Boolean).join(' · ') ||
                      'never updated'}
                    {t.lastUsedAt && <> · {timeAgo(t.lastUsedAt)}</>}
                  </p>
                </div>
                <code className="font-mono text-xs text-muted-foreground">
                  {t.prefix}…
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Revoke the token for ${t.name}`}
                  onClick={() => setRevoking(t)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && !pending && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke the token for {revoking?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The device using it can no longer update this name. The record
              stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            <Button variant="destructive" onClick={revoke} disabled={pending}>
              {pending ? 'Revoking…' : 'Revoke token'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CreatedPanel({
  created,
  apiUrl,
}: {
  created: Created;
  apiUrl: string;
}) {
  const s = dynSnippets(apiUrl, created.fqdn, created.token);
  const block = (label: string, text: string, copy = text) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <CopyButton value={copy} />
      </div>
      <pre className="overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted p-2.5 font-mono text-[11px]">
        {text}
      </pre>
    </div>
  );
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4"
    >
      <p className="font-medium">
        Token for {created.fqdn}. Copy it now, it is shown only once.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">
          {created.token}
        </code>
        <CopyButton value={created.token} />
      </div>
      {block('Router or ddclient (DynDNS2)', s.ddclient)}
      <div className="rounded-sm bg-muted p-2.5 text-xs">
        <p className="font-medium">Router settings</p>
        <p className="mt-1 text-muted-foreground">
          Service: <span className="text-foreground">DynDNS / custom</span> ·
          Server: <span className="font-mono text-foreground">{s.server}</span>
          {s.https ? ' (HTTPS)' : ''} · Path:{' '}
          <span className="font-mono text-foreground">{s.routerPath}</span> ·
          Username: any · Password: the token
        </p>
      </div>
      {block('From a script or cron job', s.curl)}
      <p className="text-xs text-muted-foreground">
        Without an address, the update uses the one the request comes from.
        Updates that change nothing are ignored, so it is safe to run every
        minute.
      </p>
    </div>
  );
}
