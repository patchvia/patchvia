import type { ClusterPeer } from './types';

export type PeerHealth = 'ok' | 'error' | 'never';

/** A peer that has been reached and is not failing is fine; one that has errors is not; one never reached is still joining. */
export function peerHealth(
  p: Pick<ClusterPeer, 'lastContact' | 'lastError'>,
): PeerHealth {
  if (p.lastError) return 'error';
  return p.lastContact ? 'ok' : 'never';
}

export function unhealthyPeers<
  T extends Pick<ClusterPeer, 'lastContact' | 'lastError'>,
>(peers: T[]): T[] {
  return peers.filter((p) => peerHealth(p) === 'error');
}
