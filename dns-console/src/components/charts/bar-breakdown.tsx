'use client';

import { useId, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { compact, percent } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface BarRow {
  label: string;
  value: number;
}

/**
 * Horizontal bars for one measure across categories. One hue (the accent); with `highlight`, that row wears the
 * accent and the rest recede to gray (emphasis, not categorical color). Bars are 20px, rounded at the data end and
 * square at the baseline, values sit at the tip, and every row has a tooltip and a table view for non-visual readers.
 */
export function BarBreakdown({
  title,
  description,
  rows,
  highlight,
  empty,
}: {
  title: string;
  description?: string;
  rows: BarRow[];
  highlight?: string;
  empty: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const tableId = useId();
  const total = rows.reduce((n, r) => n + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => b.value - a.value);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {rows.length > 0 && (
          <div
            role="group"
            aria-label={`${title} view`}
            className="flex shrink-0 rounded-md border p-0.5 text-xs"
          >
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-controls={tableId}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-sm px-2 py-1 capitalize transition-colors',
                  view === v
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent id={tableId}>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        ) : view === 'table' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 text-right font-medium">Queries</th>
                <th className="pb-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {sorted.map((r) => (
                <tr key={r.label} className="border-t">
                  <td className="py-1.5">{r.label}</td>
                  <td className="py-1.5 text-right">
                    {r.value.toLocaleString('en-US')}
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {percent(r.value, total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="flex flex-col gap-2">
            {sorted.map((r) => {
              const dim = highlight !== undefined && r.label !== highlight;
              return (
                <li
                  key={r.label}
                  className="group relative grid grid-cols-[5rem_1fr] items-center gap-3"
                  aria-label={`${r.label}: ${r.value.toLocaleString('en-US')} queries, ${percent(r.value, total)}`}
                >
                  <span className="truncate text-sm text-muted-foreground">
                    {r.label}
                  </span>
                  <div className="flex items-center gap-2 pr-14">
                    <div
                      className={cn(
                        'h-5 min-w-[3px] rounded-r-[4px] transition-opacity',
                        dim ? 'bg-muted-foreground/35' : 'bg-primary',
                      )}
                      style={{ width: `${(r.value / max) * 100}%` }}
                    />
                    <span className="absolute right-0 w-12 text-right text-sm tabular-nums">
                      {compact(r.value)}
                    </span>
                  </div>
                  {/* the hit target is the whole row, larger than the 20px mark */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute -top-8 left-20 z-10 hidden whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md group-hover:block"
                  >
                    {r.label} · {r.value.toLocaleString('en-US')} ·{' '}
                    {percent(r.value, total)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
