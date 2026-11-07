'use client';

import {
  Eye,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { applyChangesAction } from '@/actions/zones';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  EDITABLE_TYPES,
  displayName,
  formatTtl,
  summarise,
} from '@/lib/records';
import {
  addRecord,
  bulk,
  countChanges,
  diff,
  moveRecord,
  removeRecord,
  restoreRecord,
  rowId,
  setTtl,
  toDraft,
  toRows,
  updateRecord,
  type BulkOp,
  type NewRecord,
  type Row,
} from '@/lib/rrset-draft';
import type { ZoneDetail } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RecordDialog } from './record-dialog';
import { ReviewDialog } from './review-dialog';
import { SoaDialog } from './soa-dialog';

const ALL = 'all';
const GRID =
  'md:grid-cols-[2rem_minmax(0,1.2fr)_4.5rem_3.5rem_minmax(0,2fr)_2.25rem]';
/** Secondary zones are read-only: no selection column and no row actions */
const GRID_READONLY =
  'md:grid-cols-[minmax(0,1.2fr)_4.5rem_3.5rem_minmax(0,2fr)]';

const STATUS_BORDER: Record<Row['status'], string> = {
  unchanged: 'border-l-transparent',
  added: 'border-l-emerald-500',
  modified: 'border-l-amber-500',
  deleted: 'border-l-destructive',
};

export function RecordEditor({
  zone: initial,
  readOnly = false,
}: {
  zone: ZoneDetail & { accountName?: string | null };
  readOnly?: boolean;
}) {
  const zoneName = initial.name;
  const grid = readOnly ? GRID_READONLY : GRID;
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toDraft(initial.rrsets));
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ row: Row | null } | null>(null);
  const [soaOpen, setSoaOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const rows = useMemo(
    () => toRows(saved.rrsets, draft, zoneName),
    [saved, draft, zoneName],
  );
  const changes = useMemo(() => diff(saved.rrsets, draft), [saved, draft]);
  const counts = countChanges(rows);
  const soa = rows.find((r) => r.type === 'SOA');
  const records = rows.filter((r) => r.type !== 'SOA');
  const lastTtl = records.find((r) => r.status !== 'deleted')?.ttl ?? 300;

  // Unsaved edits are lost on reload or navigation to another site
  useEffect(() => {
    if (changes.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changes.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter(
      (r) =>
        (typeFilter === ALL || r.type === typeFilter) &&
        (!q ||
          `${displayName(r.name, zoneName)} ${r.type} ${summarise(r.type, r.content)}`
            .toLowerCase()
            .includes(q)),
    );
  }, [records, query, typeFilter, zoneName]);

  const typesPresent = useMemo(
    () => EDITABLE_TYPES.filter((t) => records.some((r) => r.type === t)),
    [records],
  );
  const selectable = filtered.filter((r) => r.status !== 'deleted');
  const allSelected =
    selectable.length > 0 && selectable.every((r) => selected.has(rowId(r)));

  // The apex must keep at least one NS record
  const apexNsLive = records.filter(
    (r) => r.type === 'NS' && r.name === zoneName && r.status !== 'deleted',
  ).length;
  const protectedRow = (r: Row) =>
    r.type === 'NS' &&
    r.name === zoneName &&
    apexNsLive <= 1 &&
    r.status !== 'deleted';

  function submitRecord(rec: NewRecord, editing: Row | null) {
    setDraft((d) => {
      if (!editing) return addRecord(d, rec);
      if (editing.name === rec.name && editing.type === rec.type)
        return setTtl(
          updateRecord(d, editing.key, editing.index, {
            content: rec.content,
            disabled: rec.disabled,
          }),
          editing.key,
          rec.ttl,
        );
      return moveRecord(d, editing.key, editing.index, rec);
    });
    setSelected(new Set());
  }

  function runBulk(op: BulkOp) {
    const ids = [...selected].filter((id) => {
      const r = rows.find((x) => rowId(x) === id);
      return r && !(op === 'delete' && protectedRow(r));
    });
    setDraft((d) => bulk(d, ids, op));
    setSelected(new Set());
  }

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  function apply() {
    setApplyError(null);
    startTransition(async () => {
      const res = await applyChangesAction(zoneName, changes);
      if (!res.ok) return setApplyError(res.error);
      setSaved(res.data!);
      setDraft(toDraft(res.data!.rrsets));
      setSelected(new Set());
      setReviewOpen(false);
      toast.success(
        `Applied ${changes.length} change${changes.length === 1 ? '' : 's'}`,
        {
          description: `Serial is now ${res.data!.serial}`,
        },
      );
    });
  }

  function discard() {
    setDraft(toDraft(saved.rrsets));
    setSelected(new Set());
  }

  return (
    <div className="flex flex-col gap-4 pb-24">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>
          Serial{' '}
          <span className="font-medium tabular-nums text-foreground">
            {saved.serial}
          </span>
        </span>
        <span>
          <span className="font-medium tabular-nums text-foreground">
            {saved.recordCount}
          </span>{' '}
          records
        </span>
        <Badge>
          {saved.kind === 'slave'
            ? 'Secondary'
            : saved.kind === 'master'
              ? 'Primary'
              : 'Native'}
        </Badge>
        {soa && !readOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={() => setSoaOpen(true)}
          >
            <Settings2 className="h-3.5 w-3.5" /> Zone authority
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter records…"
            aria-label="Filter records"
            className="pl-9"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-32" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {typesPresent.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!readOnly && (
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setDialog({ row: null })}
          >
            <Plus className="h-4 w-4" /> Add record
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-secondary/60 px-3 py-2 text-sm"
        >
          <span className="font-medium">{selected.size} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runBulk('disable')}
          >
            <EyeOff className="h-3.5 w-3.5" /> Disable
          </Button>
          <Button variant="outline" size="sm" onClick={() => runBulk('enable')}>
            <Eye className="h-3.5 w-3.5" /> Enable
          </Button>
          <Button variant="outline" size="sm" onClick={() => runBulk('delete')}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <div
          className={cn(
            'hidden items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground md:grid',
            grid,
          )}
        >
          {!readOnly && (
            <Checkbox
              checked={allSelected}
              onCheckedChange={(on) =>
                setSelected(on ? new Set(selectable.map(rowId)) : new Set())
              }
              aria-label="Select all visible records"
              disabled={selectable.length === 0}
            />
          )}
          <span>Name</span>
          <span>Type</span>
          <span>TTL</span>
          <span>Content</span>
          <span />
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {records.length === 0
              ? readOnly
                ? 'No records yet. They appear after the first transfer from the primary.'
                : 'No records yet. Add the first one.'
              : 'No record matches your filter.'}
          </p>
        ) : (
          <ul className="divide-y">
            {filtered.map((r, i) => {
              const id = rowId(r);
              const sameName = i > 0 && filtered[i - 1]!.name === r.name;
              const gone = r.status === 'deleted';
              return (
                <li
                  key={id}
                  className={cn(
                    'grid items-center gap-x-3 gap-y-1 border-l-[3px] px-3 py-2 text-sm',
                    grid,
                    STATUS_BORDER[r.status],
                    gone && 'bg-destructive/5',
                    r.status === 'added' && 'bg-emerald-500/5',
                    r.status === 'modified' && 'bg-amber-500/5',
                  )}
                >
                  {!readOnly && (
                    <Checkbox
                      checked={selected.has(id)}
                      onCheckedChange={(on) => toggle(id, on === true)}
                      disabled={gone}
                      aria-label={`Select ${r.type} record ${displayName(r.name, zoneName)}`}
                      className="hidden md:flex"
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate font-medium',
                      sameName && 'md:text-transparent md:select-none',
                      gone && 'line-through opacity-60',
                    )}
                    aria-hidden={sameName ? undefined : undefined}
                  >
                    <span className={cn(sameName && 'md:sr-only')}>
                      {displayName(r.name, zoneName)}
                    </span>
                  </span>
                  <span>
                    <Badge className="font-mono">{r.type}</Badge>
                  </span>
                  <span
                    className={cn(
                      'tabular-nums text-muted-foreground',
                      r.ttlChanged &&
                        'font-medium text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {formatTtl(r.ttl)}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 break-all font-mono text-xs',
                      (gone || r.disabled) && 'opacity-60',
                      gone && 'line-through',
                    )}
                  >
                    {summarise(r.type, r.content)}
                    {r.disabled && !gone && (
                      <Badge variant="warning" className="ml-2 font-sans">
                        Disabled
                      </Badge>
                    )}
                  </span>
                  {!readOnly && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 justify-self-end"
                          aria-label={`Actions for ${r.type} ${displayName(r.name, zoneName)}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {gone ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              setDraft((d) => restoreRecord(d, r.key, r.index))
                            }
                          >
                            <Undo2 className="h-4 w-4" /> Restore
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem
                              onSelect={() => setDialog({ row: r })}
                            >
                              <Pencil className="h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                setDraft((d) =>
                                  updateRecord(d, r.key, r.index, {
                                    disabled: !r.disabled,
                                  }),
                                )
                              }
                            >
                              {r.disabled ? (
                                <Eye className="h-4 w-4" />
                              ) : (
                                <EyeOff className="h-4 w-4" />
                              )}
                              {r.disabled ? 'Enable' : 'Disable'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={protectedRow(r)}
                              onSelect={() =>
                                setDraft((d) => removeRecord(d, r.key, r.index))
                              }
                            >
                              <Trash2 className="h-4 w-4" />{' '}
                              {protectedRow(r) ? 'Delete (last NS)' : 'Delete'}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {changes.length > 0 && (
        <div
          role="region"
          aria-label="Staged changes"
          className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 shadow-[0_-4px_20px_rgba(0,0,0,0.12)] backdrop-blur lg:left-60"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
            <p className="text-sm">
              <span className="font-semibold">{counts.total} unsaved</span>{' '}
              <span className="text-muted-foreground">
                {[
                  counts.added && `${counts.added} added`,
                  counts.modified && `${counts.modified} changed`,
                  counts.deleted && `${counts.deleted} removed`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </p>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={discard}>
                <X className="h-4 w-4" /> Discard
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setApplyError(null);
                  setReviewOpen(true);
                }}
              >
                Review &amp; apply
              </Button>
            </div>
          </div>
        </div>
      )}

      <RecordDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        zone={zoneName}
        draft={draft}
        editing={dialog?.row ?? null}
        defaultTtl={lastTtl}
        onSubmit={submitRecord}
      />
      {soa && (
        <SoaDialog
          open={soaOpen}
          onOpenChange={setSoaOpen}
          content={soa.content}
          ttl={soa.ttl}
          onSave={(content, ttl) =>
            setDraft((d) =>
              setTtl(
                updateRecord(d, soa.key, soa.index, { content }),
                soa.key,
                ttl,
              ),
            )
          }
        />
      )}
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        zone={zoneName}
        original={saved.rrsets}
        changes={changes}
        pending={pending}
        error={applyError}
        onApply={apply}
      />
    </div>
  );
}
