'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { lineDiff } from '@/lib/audit';
import { displayName } from '@/lib/records';
import type { RRset, RRsetChange } from '@/lib/types';
import { cn } from '@/lib/utils';

export function ReviewDialog({
  open,
  onOpenChange,
  zone,
  original,
  changes,
  pending,
  error,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zone: string;
  original: RRset[];
  changes: RRsetChange[];
  pending: boolean;
  error: string | null;
  onApply: () => void;
}) {
  const byKey = new Map(original.map((s) => [`${s.name}|${s.type}`, s]));
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Review {changes.length} change{changes.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Everything below is applied together. If any part is rejected,
            nothing changes.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
          <ul className="divide-y">
            {changes.map((c) => {
              const before = byKey.get(`${c.name}|${c.type}`);
              const lines = lineDiff(
                c.type,
                before,
                c.changetype === 'DELETE'
                  ? null
                  : { ttl: c.ttl!, records: c.records! },
              );
              return (
                <li key={`${c.name}|${c.type}`} className="p-3">
                  <p className="mb-1.5 text-sm">
                    <span className="font-mono text-xs rounded-sm bg-secondary px-1.5 py-0.5">
                      {c.type}
                    </span>{' '}
                    <span className="font-medium">
                      {displayName(c.name, zone)}
                    </span>
                  </p>
                  <pre className="overflow-x-auto font-mono text-xs leading-5">
                    {lines.map((l, i) => (
                      <div
                        key={i}
                        className={cn(
                          'px-1.5',
                          l.sign === '+' &&
                            'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                          l.sign === '-' &&
                            'bg-destructive/10 text-destructive',
                          l.sign === ' ' && 'text-muted-foreground',
                        )}
                      >
                        {l.sign} {l.text}
                      </div>
                    ))}
                  </pre>
                </li>
              );
            })}
          </ul>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Keep editing
          </Button>
          <Button onClick={onApply} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply {changes.length} change{changes.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
