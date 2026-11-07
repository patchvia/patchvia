import { EnvelopeError, open, seal } from './envelope.js'
import type { ChangesResponse, ClusterTransport } from './cluster.service.js'
import type { PeerAddress } from './peer-address.js'

/** Talks to peers over HTTP(S). Every body is sealed with the cluster secret, so even plain HTTP leaks nothing. */
export class HttpClusterTransport implements ClusterTransport {
  constructor(
    private readonly secret: string,
    private readonly nodeId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(peer: PeerAddress, route: string, body: object): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${peer.url}/cluster/v1/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ d: seal(this.secret, `cluster.${route}.req`, { ...body, from: this.nodeId }) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } }
      throw new Error(`cannot reach ${peer.label}: ${err.cause?.code ?? err.message}`)
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(`${peer.label} refused us: check CLUSTER_SECRET matches, this node's address is in its CLUSTER_PEERS, and cluster mode is on there`)
    }
    if (!res.ok) throw new Error(`${peer.label} answered HTTP ${res.status}`)
    const json = (await res.json().catch(() => null)) as { d?: string } | null
    try {
      return open<T>(this.secret, `cluster.${route}.res`, json?.d ?? '')
    } catch (e) {
      if (e instanceof EnvelopeError) throw new Error(`${peer.label} sent a message that did not verify: CLUSTER_SECRET differs`)
      throw e
    }
  }

  changes(peer: PeerAddress, since: number, limit: number): Promise<ChangesResponse> {
    return this.call<ChangesResponse>(peer, 'changes', { since, limit })
  }

  async nudge(peer: PeerAddress): Promise<void> {
    await this.call(peer, 'nudge', {})
  }
}
