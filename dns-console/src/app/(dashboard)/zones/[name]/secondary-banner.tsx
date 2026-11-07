import { AlertTriangle, CheckCircle2, Clock, Copy } from 'lucide-react';
import { secondaryStatus } from '@/lib/zone-status';
import type { ZoneDetail } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RetrieveButton } from './retrieve-button';

const TONE = {
  ok: {
    icon: CheckCircle2,
    box: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  pending: {
    icon: Clock,
    box: 'border-amber-500/30 bg-amber-500/5',
    text: 'text-amber-700 dark:text-amber-400',
  },
  error: {
    icon: AlertTriangle,
    box: 'border-destructive/40 bg-destructive/5',
    text: 'text-destructive',
  },
} as const;

/** Explains why a secondary zone cannot be edited, and shows how replication is doing. */
export function SecondaryBanner({
  zone,
  canManage,
}: {
  zone: ZoneDetail;
  canManage: boolean;
}) {
  const status = secondaryStatus(zone);
  if (!status) return null;
  const tone = TONE[status.tone];
  const Icon = tone.icon;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start',
        tone.box,
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', tone.text)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Secondary zone · {status.label}
        </p>
        <p className="mt-1 text-muted-foreground">
          Records are copied from{' '}
          <span className="font-mono text-xs text-foreground">
            {zone.masters.join(', ')}
          </span>{' '}
          and can’t be edited here.
          {status.detail && status.tone === 'ok' && ` ${status.detail}.`}
        </p>
        {status.tone === 'error' && (
          <p className={cn('mt-1 break-words text-xs', tone.text)} role="alert">
            {status.detail}. Queries are still answered with the last data
            received.
          </p>
        )}
      </div>
      {canManage && <RetrieveButton zone={zone.name} />}
    </div>
  );
}
