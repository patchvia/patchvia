'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createApiKeyAction, revokeApiKeyAction } from '@/actions/api-keys';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { timeAgo } from '@/lib/format';
import type { ApiKey } from '@/lib/types';

function snippet(apiUrl: string, key: string) {
  return `curl -fsS ${apiUrl}/v1/zones \\\n  -H "X-API-Key: ${key}"`;
}

export function ApiKeysPanel({
  keys,
  apiUrl,
}: {
  keys: ApiKey[];
  apiUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [created, setCreated] = useState<(ApiKey & { key: string }) | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await createApiKeyAction({ name, scope });
      if (!res.ok) return setError(res.error);
      setCreated(res.data!);
      setName('');
      router.refresh();
    });
  }

  function revoke(k: ApiKey) {
    startTransition(async () => {
      const res = await revokeApiKeyAction(k.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Revoked ${k.name}`);
      if (created?.id === k.id) setCreated(null);
      router.refresh();
    });
  }

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          For scripts and automation. A key acts as you, within its scope.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>
            Read keys can only look. Write keys can change records. Neither can
            manage users, passwords or other keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="key-name" className="text-xs font-medium">
                Name
              </label>
              <Input
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Deploy script"
                maxLength={64}
                required
                className="w-56"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="key-scope" className="text-xs font-medium">
                Scope
              </label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as typeof scope)}
              >
                <SelectTrigger id="key-scope" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Read only</SelectItem>
                  <SelectItem value="write">Read &amp; write</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={pending || !name.trim()}>
              Create key
            </Button>
          </form>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {created && (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4"
            >
              <p className="text-sm font-medium">
                Key “{created.name}” created. Copy it now, it is shown only
                once.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">
                  {created.key}
                </code>
                <CopyButton value={created.key} />
              </div>
              <pre className="overflow-auto rounded-sm bg-muted p-3 font-mono text-xs">
                {snippet(apiUrl, created.key)}
              </pre>
              <div>
                <CopyButton
                  value={snippet(apiUrl, created.key)}
                  label="Copy example"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              You have no API keys.
            </p>
          ) : (
            <ul className="divide-y">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{k.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {k.prefix}…
                    </p>
                  </div>
                  <Badge variant={k.scope === 'write' ? 'warning' : 'default'}>
                    {k.scope === 'write' ? 'Read & write' : 'Read only'}
                  </Badge>
                  <p className="w-40 text-xs text-muted-foreground">
                    {k.lastUsedAt
                      ? `Used ${timeAgo(k.lastUsedAt)}`
                      : 'Never used'}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Revoke ${k.name}`}
                    onClick={() => revoke(k)}
                    disabled={pending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
