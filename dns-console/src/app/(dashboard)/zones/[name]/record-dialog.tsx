'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { Switch } from '@/components/ui/switch';
import {
  EDITABLE_TYPES,
  TTL_PRESETS,
  TYPE_SPECS,
  composeContent,
  contentError,
  displayName,
  nameError,
  parseContent,
  toFqdn,
} from '@/lib/records';
import {
  conflictError,
  keyOf,
  type Draft,
  type NewRecord,
  type Row,
} from '@/lib/rrset-draft';
import type { RecordType } from '@/lib/types';
import { cn } from '@/lib/utils';

const CUSTOM = 'custom';
const WIDTH = {
  sm: 'col-span-1',
  md: 'col-span-2',
  full: 'col-span-4',
} as const;

export function RecordDialog({
  open,
  onOpenChange,
  zone,
  draft,
  editing,
  defaultTtl,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zone: string;
  draft: Draft;
  /** The row being edited, or null when adding */
  editing: Row | null;
  defaultTtl: number;
  onSubmit: (rec: NewRecord, editing: Row | null) => void;
}) {
  const [name, setName] = useState('@');
  const [type, setType] = useState<RecordType>('A');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [ttl, setTtl] = useState(String(defaultTtl));
  const [ttlMode, setTtlMode] = useState<string>(String(defaultTtl));
  const [enabled, setEnabled] = useState(true);
  const [touched, setTouched] = useState(false);
  const [ttlTouched, setTtlTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setTtlTouched(false);
    if (editing) {
      setName(displayName(editing.name, zone));
      setType(editing.type);
      setFields(parseContent(editing.type, editing.content));
      setTtl(String(editing.ttl));
      setTtlMode(
        TTL_PRESETS.some((p) => p.value === editing.ttl)
          ? String(editing.ttl)
          : CUSTOM,
      );
      setEnabled(!editing.disabled);
    } else {
      setName('@');
      setType('A');
      setFields({});
      setTtl(String(defaultTtl));
      setTtlMode(
        TTL_PRESETS.some((p) => p.value === defaultTtl)
          ? String(defaultTtl)
          : CUSTOM,
      );
      setEnabled(true);
    }
  }, [open, editing, zone, defaultTtl]);

  const fqdn = toFqdn(name, zone);
  // A new record joins the existing RRset at that name, which shares one TTL: start from it rather than changing it
  const existingTtl = editing ? undefined : draft.get(keyOf(fqdn, type))?.ttl;
  useEffect(() => {
    if (!open || editing || ttlTouched) return;
    const t = existingTtl ?? defaultTtl;
    setTtl(String(t));
    setTtlMode(TTL_PRESETS.some((p) => p.value === t) ? String(t) : CUSTOM);
  }, [open, editing, ttlTouched, existingTtl, defaultTtl]);

  const content = composeContent(type, fields);
  const spec = TYPE_SPECS[type];
  const ttlNumber = Number(ttl);

  const errors = useMemo(() => {
    const out: {
      name?: string;
      content?: string;
      ttl?: string;
      form?: string;
    } = {};
    out.name = nameError(fqdn, { wildcard: true }) ?? undefined;
    out.content = contentError(type, content) ?? undefined;
    if (!/^\d+$/.test(ttl) || ttlNumber > 2147483647)
      out.ttl = 'TTL must be a whole number of seconds';
    if (!out.name)
      out.form =
        conflictError(
          draft,
          zone,
          fqdn,
          type,
          editing ? { key: editing.key, index: editing.index } : undefined,
        ) ?? undefined;
    if (!out.content && !out.form) {
      const same = draft.get(keyOf(fqdn, type));
      const dup = same?.records.some(
        (r, i) =>
          !r.deleted &&
          r.content === content &&
          !(
            editing &&
            editing.key === keyOf(fqdn, type) &&
            editing.index === i
          ),
      );
      if (dup) out.form = 'This exact record already exists';
    }
    return out;
  }, [fqdn, type, content, ttl, ttlNumber, draft, zone, editing]);

  const siblings = (() => {
    const set = draft.get(keyOf(fqdn, type));
    const n = set?.records.filter((r) => !r.deleted).length ?? 0;
    return editing && editing.key === keyOf(fqdn, type) ? n - 1 : n;
  })();

  const invalid = !!(
    errors.name ||
    errors.content ||
    errors.ttl ||
    errors.form
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    onSubmit(
      { name: fqdn, type, ttl: ttlNumber, content, disabled: !enabled },
      editing,
    );
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit record' : 'Add record'}</DialogTitle>
            <DialogDescription>
              {spec.blurb}. Changes are staged until you apply them.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="rec-name" className="text-sm font-medium">
                Name
              </label>
              <div className="flex">
                <Input
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  id="rec-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="@ or www"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-r-none"
                  aria-invalid={touched && !!errors.name}
                />
                <span className="flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-l-0 bg-muted px-2.5 text-xs text-muted-foreground">
                  .{zone}
                </span>
              </div>
              {touched && errors.name && (
                <p role="alert" className="text-xs text-destructive">
                  {errors.name}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="rec-type" className="text-sm font-medium">
                Type
              </label>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as RecordType);
                  setFields({});
                }}
              >
                <SelectTrigger id="rec-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EDITABLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            {spec.fields.map((f, i) => (
              <div
                key={f.key}
                className={cn('flex flex-col gap-1', WIDTH[f.width ?? 'full'])}
              >
                <label htmlFor={`rec-${f.key}`} className="text-sm font-medium">
                  {f.label}
                </label>
                <Input
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  id={`rec-${f.key}`}
                  value={fields[f.key] ?? ''}
                  onChange={(e) =>
                    setFields({ ...fields, [f.key]: e.target.value })
                  }
                  placeholder={f.placeholder}
                  inputMode={f.inputMode}
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={i === 0 && !!editing}
                  aria-invalid={touched && !!errors.content}
                />
              </div>
            ))}
            {touched && errors.content && (
              <p role="alert" className="col-span-4 text-xs text-destructive">
                {errors.content}
              </p>
            )}
          </div>

          <div className="grid grid-cols-[1fr_1fr] items-start gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="rec-ttl" className="text-sm font-medium">
                TTL
              </label>
              <Select
                value={ttlMode}
                onValueChange={(v) => {
                  setTtlTouched(true);
                  setTtlMode(v);
                  if (v !== CUSTOM) setTtl(v);
                }}
              >
                <SelectTrigger id="rec-ttl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={String(p.value)}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM}>Custom…</SelectItem>
                </SelectContent>
              </Select>
              {ttlMode === CUSTOM && (
                <Input
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  value={ttl}
                  onChange={(e) => {
                    setTtlTouched(true);
                    setTtl(e.target.value);
                  }}
                  inputMode="numeric"
                  aria-label="TTL in seconds"
                  placeholder="seconds"
                />
              )}
              {touched && errors.ttl && (
                <p role="alert" className="text-xs text-destructive">
                  {errors.ttl}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Status</span>
              <label className="flex h-9 items-center gap-2 text-sm">
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Enabled"
                />
                {enabled ? 'Enabled' : 'Disabled (not served)'}
              </label>
            </div>
          </div>

          {siblings > 0 && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              TTL is shared by every {type} record at this name, so changing it
              updates the other {siblings}{' '}
              {siblings === 1 ? 'record' : 'records'} too.
            </p>
          )}
          {touched && errors.form && (
            <p role="alert" className="text-sm text-destructive">
              {errors.form}
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
            <Button type="submit">
              {editing ? 'Stage changes' : 'Stage record'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
