import { hashPassword } from '../src/auth/password.js'
import { ClusterService, type ChangesResponse, type ClusterTransport } from '../src/cluster/cluster.service.js'
import type { PeerAddress } from '../src/cluster/peer-address.js'
import { buildSnapshot } from '../src/cluster/snapshot.js'
import { ClusterStore } from '../src/cluster/store.js'
import { openDatabase } from '../src/db/database.js'
import { DnssecKeyRepository } from '../src/dnssec/key-repository.js'
import { DynDnsRepository } from '../src/dyndns/dyndns.repository.js'
import { DynDnsService } from '../src/dyndns/dyndns.service.js'
import { UsersRepository } from '../src/users/users.repository.js'
import { AuditRepository } from '../src/zones/audit-repository.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ZoneService } from '../src/zones/zone-service.js'

export const rec = (...c: string[]) => c.map((content) => ({ content, disabled: false }))

/** A network of nodes where links can be cut, so partitions and relays can be tested without sockets. */
export class Net {
  readonly nodes = new Map<string, TestNode>()
  private readonly blocked = new Set<string>()
  /** every call that crossed the network, for assertions about traffic */
  calls: { from: string; to: string; since: number }[] = []

  cut(a: string, b: string): void {
    this.blocked.add(`${a}>${b}`)
    this.blocked.add(`${b}>${a}`)
  }
  heal(): void {
    this.blocked.clear()
  }
  isolate(id: string): void {
    for (const other of this.nodes.keys()) if (other !== id) this.cut(id, other)
  }

  transportFor(from: string): ClusterTransport {
    return {
      changes: async (peer: PeerAddress, since: number, limit: number): Promise<ChangesResponse> => {
        const to = peer.label
        if (this.blocked.has(`${from}>${to}`)) throw new Error(`${to} is unreachable`)
        this.calls.push({ from, to, since })
        return this.nodes.get(to)!.cluster.handleChanges(since, limit)
      },
      nudge: async () => undefined,
    }
  }

  node(id: string, peers: string[], opts: { startMs?: number; pageSize?: number } = {}): TestNode {
    const n = new TestNode(id, this, peers, opts)
    this.nodes.set(id, n)
    return n
  }

  /** Everyone pulls from everyone, `rounds` times, in a fixed order. */
  async sync(rounds = 3): Promise<void> {
    for (let i = 0; i < rounds; i++) for (const n of this.nodes.values()) await n.cluster.syncAll()
  }
}

export class TestNode {
  readonly db = openDatabase(':memory:')
  readonly repo = new ZoneRepository(this.db)
  readonly index = new ZoneIndex()
  readonly audit = new AuditRepository(this.db)
  readonly keys = new DnssecKeyRepository(this.db)
  readonly zones = new ZoneService(this.repo, this.index, this.audit, undefined, this.keys)
  readonly users = new UsersRepository(this.db)
  readonly dynRepo = new DynDnsRepository(this.db)
  readonly dyn = new DynDnsService(this.dynRepo, this.zones, () => this.t, this.audit)
  readonly store = new ClusterStore(this.db)
  readonly cluster: ClusterService
  /** this node's wall clock, settable */
  t: number

  constructor(
    readonly id: string,
    net: Net,
    peers: string[],
    opts: { startMs?: number; pageSize?: number },
  ) {
    this.t = opts.startMs ?? 1_800_000_000_000
    this.cluster = new ClusterService(
      this.db,
      this.store,
      this.zones,
      net.transportFor(id),
      { nodeId: id, peers: peers.map((p) => ({ url: `mem://${p}`, host: p, label: p })), syncSeconds: 3600, now: () => this.t, pageSize: opts.pageSize },
      this.audit,
    )
    this.cluster.attach()
  }

  advance(ms: number): void {
    this.t += ms
  }

  async addUser(username: string, role: 'admin' | 'operator' | 'user', accounts: string[] = []) {
    const u = this.users.create(username, await hashPassword('password-for-' + username), role)
    const ids = accounts.map((a) => this.users.listAccounts().find((x) => x.name === a)!.id)
    if (ids.length) this.users.setAccounts(u.id, ids)
    return u
  }

  /** What this node would replicate right now: key to content hash. Two converged nodes have equal maps. */
  fingerprint(): Record<string, string> {
    const snap = buildSnapshot(this.db, { small: true, zones: 'all' })
    return Object.fromEntries([...snap.values()].map((e) => [e.key, e.hash]).sort())
  }
}

export function allConverged(nodes: TestNode[]): boolean {
  const first = JSON.stringify(nodes[0]!.fingerprint())
  return nodes.every((n) => JSON.stringify(n.fingerprint()) === first)
}

export function trio(): { net: Net; a: TestNode; b: TestNode; c: TestNode } {
  const net = new Net()
  const a = net.node('ns1', ['ns2', 'ns3'])
  const b = net.node('ns2', ['ns1', 'ns3'])
  const c = net.node('ns3', ['ns1', 'ns2'])
  return { net, a, b, c }
}
