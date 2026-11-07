'use client';

import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createAccountAction,
  deleteAccountAction,
  updateAccountAction,
} from '@/actions/users';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { Account } from '@/lib/types';

type Row = Account & { members: number; zones: number };

function AccountDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: Row | null;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? '');
    setDescription(account?.description ?? '');
    setError(null);
  }, [open, account]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const input = { name, description };
      const res = account
        ? await updateAccountAction(account.id, input)
        : await createAccountAction(input);
      if (!res.ok) return setError(res.error);
      toast.success(account ? 'Account updated' : `Account ${name} created`);
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {account ? 'Edit account' : 'New account'}
            </DialogTitle>
            <DialogDescription>
              An account groups zones so you can give users access to exactly
              those.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor="a-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              id="a-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoFocus
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="a-desc" className="text-sm font-medium">
              Description
            </label>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              id="a-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder="Optional"
            />
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
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? 'Saving…' : account ? 'Save' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsPanel({ accounts }: { accounts: Row[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ account: Row | null } | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!removing) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteAccountAction(removing.id);
      if (!res.ok) return setError(res.error);
      toast.success(`Deleted ${removing.name}`);
      setRemoving(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Accounts</h1>
          <p className="text-sm text-muted-foreground">Who owns which zones</p>
        </div>
        <Button size="sm" onClick={() => setDialog({ account: null })}>
          <Plus className="h-4 w-4" /> New account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed py-14 text-center">
          <p className="font-medium">No accounts yet</p>
          <p className="text-sm text-muted-foreground">
            Create one, assign zones to it, then add users to give them access.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul className="divide-y">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.name}</p>
                  {a.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {a.description}
                    </p>
                  )}
                </div>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {a.zones} {a.zones === 1 ? 'zone' : 'zones'} · {a.members}{' '}
                  {a.members === 1 ? 'user' : 'users'}
                </p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Actions for ${a.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => setDialog({ account: a })}
                    >
                      <Pencil className="h-4 w-4" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        setError(null);
                        setRemoving(a);
                      }}
                    >
                      <Trash2 className="h-4 w-4" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AccountDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        account={dialog?.account ?? null}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => !o && !pending && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {removing?.zones ?? 0} zone{removing?.zones === 1 ? '' : 's'}{' '}
              are kept but become unassigned, and its users lose access to them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              {pending ? 'Deleting…' : 'Delete account'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
