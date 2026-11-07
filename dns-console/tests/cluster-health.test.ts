import { describe, expect, it } from 'vitest';
import { peerHealth, unhealthyPeers } from '@/lib/cluster-health';

describe('peer health', () => {
  const ok = { lastContact: '2026-10-14T12:00:00Z', lastError: null };
  it('classifies peers', () => {
    expect(peerHealth(ok)).toBe('ok');
    expect(peerHealth({ lastContact: null, lastError: null })).toBe('never');
    expect(
      peerHealth({
        lastContact: ok.lastContact,
        lastError: 'cannot reach ns2',
      }),
    ).toBe('error');
    expect(peerHealth({ lastContact: null, lastError: 'refused' })).toBe(
      'error',
    );
  });
  it('lists only the failing ones', () => {
    const bad = { lastContact: null, lastError: 'x' };
    expect(
      unhealthyPeers([ok, bad, { lastContact: null, lastError: null }]),
    ).toEqual([bad]);
  });
});
