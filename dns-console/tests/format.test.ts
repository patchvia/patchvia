import { describe, expect, it } from 'vitest';
import { compact, formatUptime, percent, timeAgo } from '@/lib/format';

describe('format', () => {
  it('compacts large numbers but keeps small ones exact', () => {
    expect(compact(0)).toBe('0');
    expect(compact(1284)).toBe('1,284');
    expect(compact(9999)).toBe('9,999');
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
    expect(compact(250_000)).toBe('250K');
  });
  it('formats uptime', () => {
    expect(formatUptime(5)).toBe('5s');
    expect(formatUptime(125)).toBe('2m');
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatUptime(2 * 86400 + 3 * 3600)).toBe('2d 3h');
  });
  it('formats relative times', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(timeAgo('2026-10-14T11:57:00Z', now)).toBe('3 minutes ago');
    expect(timeAgo('2026-10-14T12:00:02Z', now)).toBe('just now');
    expect(timeAgo('2026-10-12T12:00:00Z', now)).toBe('2 days ago');
  });
  it('formats percentages', () => {
    expect(percent(0, 0)).toBe('0%');
    expect(percent(1, 3)).toBe('33%');
    expect(percent(1, 50)).toBe('2.0%');
    expect(percent(0, 10)).toBe('0%');
  });
});

import { visibleGroups } from '@/lib/nav';

describe('navigation by role', () => {
  const ids = (role: 'admin' | 'operator' | 'user') =>
    visibleGroups(role).flatMap((g) => g.items.map((i) => i.id));
  it('shows admins everything', () => {
    expect(ids('admin')).toEqual([
      'dashboard',
      'zones',
      'users',
      'cluster',
      'accounts',
      'api-keys',
      'security',
    ]);
  });
  it('hides administration from operators and the dashboard from plain users', () => {
    expect(ids('operator')).toEqual([
      'dashboard',
      'zones',
      'api-keys',
      'security',
    ]);
    expect(ids('user')).toEqual(['zones', 'api-keys', 'security']);
  });
});

import { secondaryStatus } from '@/lib/zone-status';

describe('secondaryStatus', () => {
  const base = {
    kind: 'slave' as const,
    serial: 5,
    lastCheck: '2026-10-14T11:57:00Z',
    lastTransfer: null,
    transferError: null,
  };
  const now = Date.parse('2026-10-14T12:00:00Z');
  it('is null for zones that are not secondaries', () => {
    expect(secondaryStatus({ ...base, kind: 'native' })).toBeNull();
    expect(secondaryStatus({ ...base, kind: 'master' })).toBeNull();
  });
  it('reports errors first, then pending, then in sync', () => {
    expect(
      secondaryStatus({ ...base, transferError: 'connection refused' }, now),
    ).toEqual({
      tone: 'error',
      label: 'Transfer failing',
      detail: 'connection refused',
    });
    expect(secondaryStatus({ ...base, serial: 0 }, now)).toEqual({
      tone: 'pending',
      label: 'Waiting for first transfer',
    });
    expect(secondaryStatus(base, now)).toEqual({
      tone: 'ok',
      label: 'In sync',
      detail: 'Checked 3 minutes ago',
    });
  });
  it('keeps serving stale data visible: an error wins even when a serial exists', () => {
    expect(secondaryStatus({ ...base, transferError: 'x' }, now)!.tone).toBe(
      'error',
    );
  });
});
