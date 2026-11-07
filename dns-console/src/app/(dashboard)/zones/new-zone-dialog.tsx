'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { createZoneAction } from '@/actions/zones';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { nameError } from '@/lib/records';
import type { Account } from '@/lib/types';

const NONE = 'none';

export function NewZoneDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [nameservers, setNameservers] = useState('');
  const [masters, setMasters] = useState('');
  const [kind, setKind] = useState<'native' | 'master' | 'slave'>('native');
  const [accountId, setAccountId] = useState(NONE);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setName('');
      setNameservers('');
      setMasters('');
      setKind('native');
      setAccountId(NONE);
      setError(null);
    }
  }, [open]);

  const cleanName = name.trim().toLowerCase().replace(/\.$/, '');
  const invalid = cleanName ? nameError(cleanName) : null;
  const mastersList = masters.split(/[\s,]+/).filter(Boolean);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cleanName || invalid || (kind === 'slave' && !mastersList.length))
      return;
    setError(null);
    startTransition(async () => {
      const res = await createZoneAction({
        name: cleanName,
        nameservers: nameservers.split(/[\s,]+/).filter(Boolean),
        masters: mastersList,
        kind,
        accountId: accountId === NONE ? null : Number(accountId),
      });
      if (!res.ok) return setError(res.error);
      onOpenChange(false);
      router.push(`/zones/${res.data!.name}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New zone</DialogTitle>
            <DialogDescription>
              A native or primary zone holds its own records. A secondary copies
              them from a primary server.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <label htmlFor="zone-name" className="text-sm font-medium">
              Domain name
            </label>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              id="zone-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="example.com"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={!!invalid}
            />
            {invalid && (
              <p role="alert" className="text-xs text-destructive">
                {invalid}
              </p>
            )}
          </div>

          {kind === 'slave' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="zone-masters" className="text-sm font-medium">
                Primary servers
              </label>
              <Input
                id="zone-masters"
                value={masters}
                onChange={(e) => setMasters(e.target.value)}
                placeholder="192.0.2.1, ns1.example.net:5353"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Where to transfer the zone from. The primary must allow this
                server in its transfer settings.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor="zone-ns" className="text-sm font-medium">
                Nameservers
              </label>
              <Input
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                id="zone-ns"
                value={nameservers}
                onChange={(e) => setNameservers(e.target.value)}
                placeholder="ns1.example.net, ns2.example.net"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to use the server’s default nameservers.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="zone-kind" className="text-sm font-medium">
                Type
              </label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as typeof kind)}
              >
                <SelectTrigger id="zone-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native</SelectItem>
                  <SelectItem value="master">Primary</SelectItem>
                  <SelectItem value="slave">Secondary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="zone-account" className="text-sm font-medium">
                Account
              </label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="zone-account">
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
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !cleanName ||
                !!invalid ||
                (kind === 'slave' && !mastersList.length)
              }
            >
              {pending ? 'Creating…' : 'Create zone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
