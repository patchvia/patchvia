import { timeAgo } from './format';
import type { ZoneSummary } from './types';

export interface ZoneStatus {
  tone: 'ok' | 'pending' | 'error';
  label: string;
  detail?: string;
}

/** Health of a secondary zone's replication; null for zones that are not secondaries. */
export function secondaryStatus(
  z: Pick<
    ZoneSummary,
    'kind' | 'serial' | 'lastCheck' | 'lastTransfer' | 'transferError'
  >,
  now = Date.now(),
): ZoneStatus | null {
  if (z.kind !== 'slave') return null;
  if (z.transferError)
    return {
      tone: 'error',
      label: 'Transfer failing',
      detail: z.transferError,
    };
  if (z.serial === 0)
    return { tone: 'pending', label: 'Waiting for first transfer' };
  return {
    tone: 'ok',
    label: 'In sync',
    detail: z.lastCheck ? `Checked ${timeAgo(z.lastCheck, now)}` : undefined,
  };
}
