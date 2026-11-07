'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteZoneAction, setZoneAccountAction } from '@/actions/zones';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Account } from '@/lib/types';

const NONE = 'none';

export function ZoneSettings({
  name,
  kind,
  accountId,
  accountName,
  accounts,
  canManage,
}: {
  name: string;
  kind: string;
  accountId: number | null;
  accountName: string | null;
  accounts: Account[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(
    accountId === null ? NONE : String(accountId),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = account !== (accountId === null ? NONE : String(accountId));

  function saveAccount() {
    startTransition(async () => {
      const res = await setZoneAccountAction(
        name,
        account === NONE ? null : Number(account),
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Account updated');
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const res = await deleteZoneAction(name);
      if (!res.ok) return setError(res.error);
      toast.success(`Deleted ${name}`);
      router.push('/zones');
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Ownership</CardTitle>
          <CardDescription>
            {kind === 'slave'
              ? 'Users in an account can see the records of its zones, and nothing else.'
              : 'Users in an account can see and edit the records of its zones, and nothing else.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Zone type</span>
            <Badge>
              {kind === 'slave'
                ? 'Secondary'
                : kind === 'master'
                  ? 'Primary'
                  : 'Native'}
            </Badge>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="zone-account" className="text-xs font-medium">
                  Account
                </label>
                <Select value={account} onValueChange={setAccount}>
                  <SelectTrigger id="zone-account" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No account</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                onClick={saveAccount}
                disabled={!dirty || pending}
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-sm">
              <span className="text-muted-foreground">Account </span>
              {accountName ?? '—'}
            </p>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Delete zone</CardTitle>
            <CardDescription>
              Removes the zone and all of its records. The server stops
              answering for {name} immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setTyped('');
                setError(null);
                setConfirmOpen(true);
              }}
            >
              Delete this zone
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => !pending && setConfirmOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Type the zone name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={name}
            aria-label="Zone name to confirm"
            autoCapitalize="none"
            spellCheck={false}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={typed.trim().toLowerCase() !== name || pending}
              onClick={remove}
            >
              {pending ? 'Deleting…' : 'Delete zone'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
