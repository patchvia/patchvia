'use client';

import { KeyRound, Plus, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  addDnssecKeyAction,
  deleteDnssecKeyAction,
  disableDnssecAction,
  enableDnssecAction,
  updateDnssecKeyAction,
} from '@/actions/dnssec';
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
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { timeAgo } from '@/lib/format';
import type { DnssecKey, DnssecStatus } from '@/lib/types';

type Run = () => Promise<{ ok: boolean; error?: string }>;

export function DnssecCard({
  zone,
  status,
  canManage,
}: {
  zone: string;
  status: DnssecStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [disabling, setDisabling] = useState(false);
  const [confirmedDs, setConfirmedDs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(fn: Run, success: string, done?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong');
        toast.error(res.error ?? 'Something went wrong');
        return;
      }
      toast.success(success);
      done?.();
      router.refresh();
    });
  }

  const activeCount = status.keys.filter((k) => k.active).length;
  const sepKeys = status.keys.filter((k) => k.ds.length > 0 && k.published);

  if (!status.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />{' '}
            DNSSEC
          </CardTitle>
          <CardDescription>
            DNSSEC signs this zone’s answers so resolvers can prove they were
            not tampered with. It is off.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Turning it on generates a signing key (ECDSA P-256) and starts
            signing immediately. Validation only begins once you publish the
            zone’s <strong className="text-foreground">DS record</strong> at
            your registrar, so enabling it first is safe.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {canManage ? (
            <div>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => enableDnssecAction(zone), 'DNSSEC is on')
                }
              >
                <ShieldCheck className="h-4 w-4" />{' '}
                {pending ? 'Enabling…' : 'Enable DNSSEC'}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Ask an administrator to turn it on.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck
            className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />{' '}
          DNSSEC
          <Badge variant="success">Signing</Badge>
        </CardTitle>
        <CardDescription>
          Answers are signed as they are served. Give the DS record below to
          your registrar to complete the chain of trust.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        <section aria-label="DS records" className="flex flex-col gap-3">
          <h4 className="font-medium">DS record for your registrar</h4>
          {sepKeys.length === 0 ? (
            <p className="text-muted-foreground">
              No published key is a secure entry point.
            </p>
          ) : (
            sepKeys.map((k) => (
              <div
                key={k.id}
                className="flex flex-col gap-2 rounded-md border p-3"
              >
                {k.ds
                  .slice()
                  .sort((a, b) => a.digestType - b.digestType)
                  .map((d) => (
                    <div key={d.digestType} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          Digest type {d.digestType} (
                          {d.digestType === 2
                            ? 'SHA-256, widely supported'
                            : 'SHA-384'}
                          )
                        </span>
                        <CopyButton value={d.text} label="Copy" />
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_auto_auto_1fr]">
                        <div className="contents sm:block">
                          <dt className="text-muted-foreground">Key tag</dt>
                          <dd className="font-mono">{d.keyTag}</dd>
                        </div>
                        <div className="contents sm:block">
                          <dt className="text-muted-foreground">Algorithm</dt>
                          <dd className="font-mono">
                            {d.algorithm} ({k.algorithmName})
                          </dd>
                        </div>
                        <div className="contents sm:block">
                          <dt className="text-muted-foreground">Digest type</dt>
                          <dd className="font-mono">{d.digestType}</dd>
                        </div>
                        <div className="contents min-w-0 sm:block">
                          <dt className="text-muted-foreground">Digest</dt>
                          <dd className="break-all font-mono">{d.digest}</dd>
                        </div>
                      </dl>
                    </div>
                  ))}
              </div>
            ))
          )}
        </section>

        <section aria-label="Keys" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-medium">Keys</h4>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => run(() => addDnssecKeyAction(zone), 'Key added')}
              >
                <Plus className="h-3.5 w-3.5" /> Add key (rollover)
              </Button>
            )}
          </div>
          <ul className="divide-y rounded-md border">
            {status.keys.map((k) => (
              <KeyRow
                key={k.id}
                k={k}
                canManage={canManage}
                pending={pending}
                onlyActive={k.active && activeCount === 1}
                onActivate={() =>
                  run(
                    () => updateDnssecKeyAction(zone, k.id, { active: true }),
                    `Key ${k.keyTag} is signing`,
                  )
                }
                onDeactivate={() =>
                  run(
                    () => updateDnssecKeyAction(zone, k.id, { active: false }),
                    `Key ${k.keyTag} stopped signing`,
                  )
                }
                onDelete={() =>
                  run(
                    () => deleteDnssecKeyAction(zone, k.id),
                    `Key ${k.keyTag} deleted`,
                  )
                }
              />
            ))}
          </ul>
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">
              How to replace a key without breaking validation
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Add a key. It is published but does not sign yet.</li>
              <li>
                Give the new key’s DS record to your registrar, and keep the old
                one.
              </li>
              <li>Wait for the old DS record’s TTL to pass (usually a day).</li>
              <li>
                Make the new key sign, then stop the old key from signing.
              </li>
              <li>
                Wait again, remove the old DS at the registrar, then delete the
                old key.
              </li>
            </ol>
          </details>
        </section>

        <details>
          <summary className="cursor-pointer text-muted-foreground">
            DNSKEY records
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {status.keys
              .filter((k) => k.published)
              .map((k) => (
                <div key={k.id} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-[11px]">
                    {zone}. IN DNSKEY {k.dnskey}
                  </code>
                  <CopyButton value={`${zone}. IN DNSKEY ${k.dnskey}`} />
                </div>
              ))}
          </div>
        </details>

        <p className="text-xs text-muted-foreground">
          Signed zones cannot be transferred to secondary servers: this server
          signs them online.
        </p>

        {canManage && (
          <div className="border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={pending}
              onClick={() => {
                setConfirmedDs(false);
                setDisabling(true);
              }}
            >
              <ShieldOff className="h-3.5 w-3.5" /> Turn off DNSSEC
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={disabling}
        onOpenChange={(o) => !pending && setDisabling(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off DNSSEC for {zone}?</AlertDialogTitle>
            <AlertDialogDescription>
              If your registrar still has a DS record for this zone, validating
              resolvers will treat every answer as forged and the zone will stop
              resolving for them. Remove the DS record first, and wait for its
              TTL.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={confirmedDs}
              onCheckedChange={(c) => setConfirmedDs(c === true)}
              className="mt-0.5"
            />
            I have removed the DS record at my registrar and waited for it to
            expire.
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              Keep signing
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!confirmedDs || pending}
              onClick={() =>
                run(
                  () => disableDnssecAction(zone),
                  'DNSSEC is off',
                  () => setDisabling(false),
                )
              }
            >
              {pending ? 'Turning off…' : 'Turn off DNSSEC'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function KeyRow({
  k,
  canManage,
  pending,
  onlyActive,
  onActivate,
  onDeactivate,
  onDelete,
}: {
  k: DnssecKey;
  canManage: boolean;
  pending: boolean;
  onlyActive: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <KeyRound
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs">
          Key {k.keyTag} · {k.algorithmName} · {k.role}
        </p>
        <p className="text-xs text-muted-foreground">
          Created {timeAgo(k.createdAt)}
        </p>
      </div>
      {k.active ? (
        <Badge variant="success">Signing</Badge>
      ) : k.published ? (
        <Badge variant="warning">Published only</Badge>
      ) : (
        <Badge>Not published</Badge>
      )}
      {canManage && (
        <div className="flex gap-1.5">
          {k.active ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending || onlyActive}
              title={
                onlyActive ? 'At least one key must keep signing' : undefined
              }
              onClick={onDeactivate}
            >
              Stop signing
            </Button>
          ) : (
            <>
              {k.published && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={onActivate}
                >
                  Start signing
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={onDelete}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
