'use client';

import { AlertTriangle, FileUp, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { importZoneAction } from '@/actions/zones';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import type { Account, ImportSummary, ZoneSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const NONE = 'none';
const MAX_BYTES = 8_000_000;

type Mode = 'create' | 'replace';

export function ImportZoneDialog({
  open,
  onOpenChange,
  zones,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zones: ZoneSummary[];
  accounts: Account[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<'native' | 'master'>('native');
  const [accountId, setAccountId] = useState(NONE);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const replaceable = zones.filter((z) => z.kind !== 'slave');

  useEffect(() => {
    if (!open) return;
    setText('');
    setFileName(null);
    setMode('create');
    setName('');
    setTarget(replaceable[0]?.name ?? '');
    setKind('native');
    setAccountId(NONE);
    setPreview(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit makes the previous check stale
  const touch = () => {
    setPreview(null);
    setError(null);
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('That file is larger than 8 MB.');
      return;
    }
    touch();
    setText(await file.text());
    setFileName(file.name);
    e.target.value = '';
  }

  function run(dryRun: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await importZoneAction({
        zonefile: text,
        name: (mode === 'replace' ? target : name) || undefined,
        mode,
        kind,
        accountId: accountId === NONE ? null : Number(accountId),
        dryRun,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (dryRun) {
        setPreview(res.data!);
        return;
      }
      toast.success(
        `Imported ${res.data!.records} records into ${res.data!.zone}`,
      );
      onOpenChange(false);
      router.push(`/zones/${res.data!.zone}`);
    });
  }

  const ready = preview?.ok === true;
  const canCheck =
    text.trim().length > 0 && (mode === 'create' || target !== '');

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import zone file</DialogTitle>
          <DialogDescription>
            Bring a BIND-style zone file in as a new zone, or replace the
            records of an existing one. You see what will happen before anything
            is written.
          </DialogDescription>
        </DialogHeader>

        <div
          role="group"
          aria-label="Import mode"
          className="grid grid-cols-2 gap-1 rounded-md border p-1 text-sm"
        >
          {(
            [
              ['create', 'New zone'],
              ['replace', 'Replace an existing zone'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                touch();
              }}
              className={cn(
                'rounded-sm px-3 py-1.5 transition-colors',
                mode === m
                  ? 'bg-secondary font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {mode === 'create' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="imp-name" className="text-sm font-medium">
                Zone name
              </label>
              <Input
                id="imp-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  touch();
                }}
                placeholder="From $ORIGIN if empty"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor="imp-target" className="text-sm font-medium">
                Zone to replace
              </label>
              <Select
                value={target}
                onValueChange={(v) => {
                  setTarget(v);
                  touch();
                }}
              >
                <SelectTrigger id="imp-target">
                  <SelectValue placeholder="Choose a zone" />
                </SelectTrigger>
                <SelectContent>
                  {replaceable.map((z) => (
                    <SelectItem key={z.name} value={z.name}>
                      {z.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {mode === 'create' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="imp-account" className="text-sm font-medium">
                Account
              </label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="imp-account">
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
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label htmlFor="imp-text" className="text-sm font-medium">
              Zone file
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="h-3.5 w-3.5" /> Choose file…
            </Button>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={onFile}
            />
          </div>
          <Textarea
            id="imp-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
              touch();
            }}
            placeholder={
              '$ORIGIN example.com.\n$TTL 1h\n@ IN SOA ns1 hostmaster ( 1 2h 30m 1w 5m )\n  IN NS ns1\n  IN A 192.0.2.1'
            }
            className="h-48 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore
          />
          {fileName && (
            <p className="text-xs text-muted-foreground">Loaded {fileName}</p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {preview && <PreviewPanel preview={preview} />}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          {ready ? (
            <Button onClick={() => run(false)} disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {preview.mode === 'replace'
                ? `Replace with ${preview.records} records`
                : `Import ${preview.records} records`}
            </Button>
          ) : (
            <Button onClick={() => run(true)} disabled={pending || !canCheck}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Check file
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewPanel({ preview }: { preview: ImportSummary }) {
  const skipped = Object.entries(preview.skipped);
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-3 rounded-md border p-4 text-sm',
        preview.ok
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-destructive/40 bg-destructive/5',
      )}
    >
      {preview.ok ? (
        <>
          <p className="font-medium">
            {preview.zone}: {preview.records} records in {preview.rrsets} record
            sets
            {preview.serial ? `, serial ${preview.serial}` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(preview.byType).map(([t, n]) => (
              <Badge key={t} className="font-mono">
                {t} × {n}
              </Badge>
            ))}
          </div>
          {preview.mode === 'replace' && (
            <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              This replaces the zone’s current {preview.replacing ?? 0} records.
              Records not in the file are removed.
            </p>
          )}
          {!preview.hasSoa && (
            <p className="text-muted-foreground">
              No SOA in the file: the zone’s own is used.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="font-medium text-destructive">
            This file cannot be imported yet
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {preview.problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {preview.problems.length > 8 && (
              <li>and {preview.problems.length - 8} more…</li>
            )}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <p className="text-muted-foreground">
          Not imported (not supported here):{' '}
          {skipped.map(([t, n]) => `${t} × ${n}`).join(', ')}
        </p>
      )}
      {preview.warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {preview.warnings.length} warning
            {preview.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {preview.warnings.slice(0, 20).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
