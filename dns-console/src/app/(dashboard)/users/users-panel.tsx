'use client';

import { Dices, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createUserAction,
  deleteUserAction,
  updateUserAction,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  generatePassword,
} from '@/lib/password-rules';
import type { Account, Role, User } from '@/lib/types';

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, including users and accounts',
  operator: 'Create, edit and delete any zone',
  user: 'Edit records of zones in their accounts only',
};

function UserDialog({
  open,
  onOpenChange,
  user,
  accounts,
  meId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: User | null;
  accounts: Account[];
  meId: number;
}) {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [accountIds, setAccountIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username ?? '');
    setPassword('');
    setRole(user?.role ?? 'user');
    setAccountIds(user?.accountIds ?? []);
    setError(null);
  }, [open, user]);

  const pwBad =
    password.length > 0 &&
    (password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH);
  const self = user?.id === meId;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = user
        ? await updateUserAction(user.id, {
            role: role !== user.role ? role : undefined,
            password: password || undefined,
            accountIds,
          })
        : await createUserAction({ username, password, role, accountIds });
      if (!res.ok) return setError(res.error);
      toast.success(user ? 'User updated' : `User ${username} created`);
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
              {user ? `Edit ${user.username}` : 'New user'}
            </DialogTitle>
            <DialogDescription>
              {user
                ? 'Changing the role or password signs this user out everywhere.'
                : 'They can change their password after signing in.'}
            </DialogDescription>
          </DialogHeader>

          {!user && (
            <div className="flex flex-col gap-1">
              <label htmlFor="u-name" className="text-sm font-medium">
                Username
              </label>
              <Input
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                id="u-name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">
                3–64 characters: a–z, 0–9, dot, dash, underscore.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="u-pass" className="text-sm font-medium">
              {user ? 'Reset password' : 'Password'}
            </label>
            <div className="flex gap-2">
              <Input
                id="u-pass"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={user ? 'Leave empty to keep the current one' : ''}
                autoComplete="new-password"
                spellCheck={false}
                required={!user}
                aria-invalid={pwBad}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Generate a password"
                onClick={() => setPassword(generatePassword())}
              >
                <Dices className="h-4 w-4" />
              </Button>
              {password && <CopyButton value={password} label="" />}
            </div>
            {pwBad && (
              <p role="alert" className="text-xs text-destructive">
                {MIN_PASSWORD_LENGTH}–{MAX_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="u-role" className="text-sm font-medium">
              Role
            </label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as Role)}
              disabled={self}
            >
              <SelectTrigger id="u-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administrator</SelectItem>
                <SelectItem value="operator">Operator</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {self ? 'You cannot change your own role.' : ROLE_HELP[role]}
            </p>
          </div>

          {role === 'user' && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Accounts</legend>
              {accounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create an account first, then give users access to its zones.
                </p>
              ) : (
                accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={accountIds.includes(a.id)}
                      onCheckedChange={(on) =>
                        setAccountIds((ids) =>
                          on === true
                            ? [...ids, a.id]
                            : ids.filter((i) => i !== a.id),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))
              )}
            </fieldset>
          )}

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
              disabled={pending || pwBad || (!user && (!username || !password))}
            >
              {pending ? 'Saving…' : user ? 'Save' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPanel({
  users,
  accounts,
  meId,
}: {
  users: User[];
  accounts: Account[];
  meId: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ user: User | null } | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  function remove() {
    if (!removing) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteUserAction(removing.id);
      if (!res.ok) return setError(res.error);
      toast.success(`Deleted ${removing.username}`);
      setRemoving(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            {users.length} {users.length === 1 ? 'person' : 'people'} can sign
            in
          </p>
        </div>
        <Button size="sm" onClick={() => setDialog({ user: null })}>
          <Plus className="h-4 w-4" /> New user
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <ul className="divide-y">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {u.username}
                  {u.id === meId && (
                    <span className="text-xs font-normal text-muted-foreground">
                      (you)
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {u.role === 'user'
                    ? u.accountIds.length
                      ? u.accountIds
                          .map((id) => accountName.get(id) ?? `#${id}`)
                          .join(', ')
                      : 'No accounts, cannot see any zone'
                    : ROLE_HELP[u.role]}
                </p>
              </div>
              <Badge
                variant={u.role === 'admin' ? 'warning' : 'default'}
                className="capitalize"
              >
                {u.role}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Actions for ${u.username}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog({ user: u })}>
                    <Pencil className="h-4 w-4" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={u.id === meId}
                    onSelect={() => {
                      setError(null);
                      setRemoving(u);
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

      <UserDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        user={dialog?.user ?? null}
        accounts={accounts}
        meId={meId}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => !o && !pending && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out immediately and their API keys stop working.
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
              {pending ? 'Deleting…' : 'Delete user'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
