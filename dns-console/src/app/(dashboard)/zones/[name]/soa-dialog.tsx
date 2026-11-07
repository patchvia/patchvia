'use client';

import { useEffect, useState } from 'react';
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
  TYPE_SPECS,
  composeContent,
  contentError,
  parseContent,
} from '@/lib/records';

const EDITABLE = ['mname', 'rname', 'refresh', 'retry', 'expire', 'minimum'];

export function SoaDialog({
  open,
  onOpenChange,
  content,
  ttl,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  ttl: number;
  onSave: (content: string, ttl: number) => void;
}) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [ttlText, setTtlText] = useState(String(ttl));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setFields(parseContent('SOA', content));
      setTtlText(String(ttl));
      setTouched(false);
    }
  }, [open, content, ttl]);

  const next = composeContent('SOA', fields);
  const error =
    contentError('SOA', next) ??
    (/^\d+$/.test(ttlText) ? null : 'TTL must be a whole number');
  const numeric = ['refresh', 'retry', 'expire', 'minimum'].some(
    (k) => !/^\d+$/.test(fields[k] ?? ''),
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error || numeric) return;
    onSave(next, Number(ttlText));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Zone authority (SOA)</DialogTitle>
            <DialogDescription>
              The serial is managed for you and increases with every change, so
              secondary servers notice updates.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {TYPE_SPECS.SOA.fields
              .filter((f) => EDITABLE.includes(f.key))
              .map((f) => (
                <div
                  key={f.key}
                  className={`flex flex-col gap-1 ${f.width === 'full' ? 'col-span-2' : ''}`}
                >
                  <label
                    htmlFor={`soa-${f.key}`}
                    className="text-sm font-medium"
                  >
                    {f.label}
                  </label>
                  <Input
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    id={`soa-${f.key}`}
                    value={fields[f.key] ?? ''}
                    onChange={(e) =>
                      setFields({ ...fields, [f.key]: e.target.value })
                    }
                    inputMode={f.inputMode}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
              ))}
            <div className="flex flex-col gap-1">
              <label htmlFor="soa-ttl" className="text-sm font-medium">
                TTL
              </label>
              <Input
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                id="soa-ttl"
                value={ttlText}
                onChange={(e) => setTtlText(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Serial</span>
              <span className="flex h-9 items-center text-sm text-muted-foreground">
                {fields.serial} (automatic)
              </span>
            </div>
          </div>
          {touched && (error || numeric) && (
            <p role="alert" className="text-sm text-destructive">
              {error ??
                'Refresh, retry, expire and negative TTL must be numbers'}
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
            <Button type="submit">Stage changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
