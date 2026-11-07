import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { describeAudit, diffLines } from '@/lib/audit';
import { BackendError, loadHistory } from '@/lib/backend';
import { timeAgo } from '@/lib/format';
import { withSession } from '@/lib/with-session';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ZoneHistoryPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const zone = decodeURIComponent(name);
  let entries;
  try {
    entries = await withSession((token) => loadHistory(token, zone, 100));
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) notFound();
    throw e;
  }

  if (entries.length === 0)
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No changes recorded for this zone.
      </p>
    );

  return (
    <ol className="flex flex-col gap-3">
      {entries.map((e) => {
        const v = describeAudit(e);
        const lines = diffLines(e);
        return (
          <li key={e.id} className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge
                variant={
                  v.tone === 'create'
                    ? 'success'
                    : v.tone === 'delete'
                      ? 'destructive'
                      : 'default'
                }
              >
                {v.tone === 'create'
                  ? 'Added'
                  : v.tone === 'delete'
                    ? 'Removed'
                    : 'Changed'}
              </Badge>
              <span className="min-w-0 flex-1 text-sm font-medium">
                {v.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {e.actor} ·{' '}
                <time
                  dateTime={e.at}
                  title={new Date(e.at).toLocaleString('en-US')}
                >
                  {timeAgo(e.at)}
                </time>
              </span>
            </div>
            {lines.length > 0 && (
              <pre className="mt-3 overflow-x-auto rounded-md border bg-background py-1 font-mono text-xs leading-5">
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      'px-3',
                      l.sign === '+' &&
                        'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                      l.sign === '-' && 'bg-destructive/10 text-destructive',
                      l.sign === ' ' && 'text-muted-foreground',
                    )}
                  >
                    {l.sign} {l.text}
                  </div>
                ))}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}
