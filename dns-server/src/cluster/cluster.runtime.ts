import type { ClusterService } from './cluster.service.js'
import type { PeerGate } from './peer-gate.js'

/** What exists only when cluster mode is on. Injected as `null` otherwise. */
export interface ClusterRuntime {
  service: ClusterService
  gate: PeerGate
}

export const CLUSTER = 'CLUSTER'
export const CLUSTER_TRANSPORT = 'CLUSTER_TRANSPORT'
