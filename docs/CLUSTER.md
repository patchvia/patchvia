# Running several nameservers as a cluster

Run `ns1`, `ns2` and `ns3` (or two, or five), each on its own machine with its **own database**, and tell each one the
addresses of the others. Changes made on any of them, including dynamic DNS updates, spread to all of them. Every node
keeps answering queries and accepting changes if the others are down, and catches up by itself when they return.

## Set it up

On **each** node, set the same secret and a different node id, and list the *other* nodes:

| Variable | ns1 | ns2 | ns3 |
| --- | --- | --- | --- |
| `CLUSTER_NODE_ID` | `ns1` | `ns2` | `ns3` |
| `CLUSTER_SECRET` | the same 32+ characters on all three (`openssl rand -base64 36`) | | |
| `CLUSTER_PEERS` | `ns2.mydomain.com:8081,ns3.mydomain.com:8081` | `ns1.mydomain.com:8081,ns3.mydomain.com:8081` | `ns1.mydomain.com:8081,ns2.mydomain.com:8081` |
| `ADMIN_PASSWORD` | the same on all three, first start only | | |

Peers are `host`, `host:port` (default is this node's `API_PORT`), `https://host:port`, or an IP address. The API port
(8081) of each node must be reachable from the others. DNS (port 53) is what the world uses; the API port should be open
only to your nodes, for example through a firewall rule or a private network.

Open the console of any node. **Cluster** shows each peer, when it was last reached, and any problem. Start the nodes in
any order. The first sync takes a few seconds, and from then on a change shows up on the others in about a second.

Then add `ns1`, `ns2` and `ns3` as the NS records of your zones and as nameservers (with glue) at your registrar. Because
every node serves the same data, any of them can answer.

## What is kept in sync

Zones and their records, zone settings (account, type, primaries), accounts, users and their passwords, API keys, dynamic
DNS tokens and DNSSEC signing keys. That last one matters: a signed zone only validates if every nameserver signs with the
same key, so the keys travel between nodes. They are inside messages that are encrypted and authenticated with the cluster
secret, so this is safe even over plain HTTP, but use a private network or VPN between data centres anyway: the traffic
pattern is visible and the secret is the only thing between a stranger and your signing keys.

Not synced, because each node must decide for itself: the records of **secondary zones** (each node transfers them from the
primary), query statistics, and when a token or key was last used.

## How conflicts are settled

- Changes to **different** records never clash: both are kept.
- If two nodes change the **same record set** (for example both edit the A records of `www`) within moments of each other,
  the **later change wins** everywhere. "Later" uses a logical clock that respects cause and effect even when the nodes'
  clocks differ a little: if ns2 saw ns1's change and then edited, ns2's edit wins even if ns2's clock is behind.
- Deletions are remembered, so a deleted zone or record cannot come back from a node that was offline, and a zone deleted
  on one node while another added a record to it stays deleted.
- A node whose clock is more than a day ahead is ignored with a warning (it would otherwise win every conflict). Keep NTP
  running on every node.

## Things to know

- **SOA serials are per node.** Each node raises its own serial whenever its data changes, so a secondary of any one node
  always notices updates. If external secondaries pull from several of your nodes, they may see different serials for the
  same data. That is harmless: they just transfer when a serial is higher than what they have.
- **Ids differ between nodes.** Users, accounts and keys are matched by name across the cluster, but the numeric ids shown
  in the console and API belong to the node you are talking to. Point each console at one node (its own), and use names,
  not ids, in automation. Login tokens are interchangeable between nodes.
- **Signed zones are not transferred (AXFR)** to outside secondaries; the cluster is how they are replicated.
- A node that is restored from an old backup is safe: its peers notice it went backwards and send everything again.
- Two nodes must never share a `CLUSTER_NODE_ID`; this is detected and reported.

## Adding, replacing and removing a node

- **Add:** add the new node's address to `CLUSTER_PEERS` on **every** existing node and restart them. Both directions
  need this: a node only accepts cluster traffic from addresses it knows, and it only pulls changes from the peers it
  lists, so an unlisted node could read the cluster but its own changes would never flow back. Then start the new node with
  the shared secret and its peers; it pulls everything. (`CLUSTER_ALLOW_FROM` can additionally accept a whole network, for
  example a private subnet, but it does not make nodes pull from each other.)
- **A node already has zones** you want to keep: start it with the cluster settings. Its data is merged in, not replaced.
- **Replace:** start the new machine with the old one's `CLUSTER_NODE_ID` only after the old one is gone for good.
- **Remove:** take it out of `CLUSTER_PEERS` on the others. Its data stays on the other nodes.
- **Change the secret:** change it on every node, then restart them all. Syncing pauses until the last one is done; DNS
  keeps answering the whole time.

## When something is wrong

| What you see in **Cluster** | Usually |
| --- | --- |
| `cannot reach … ECONNREFUSED` / `timed out` | the node is down, or a firewall blocks its API port |
| `… refused us: check CLUSTER_SECRET matches…` | different secrets, the address of this node is not in the other's `CLUSTER_PEERS`, or cluster mode is off there |
| `… did not verify: CLUSTER_SECRET differs` | the secrets differ |
| `that address is this node, or two nodes share a CLUSTER_NODE_ID` | a peer address points at itself, or a duplicated node id |
| the node log says `ignoring …: its timestamp is … more than a day ahead` | that node's clock is wrong |
| `not rebuilt yet … the previous version keeps serving` | a zone arrived in pieces (for example DNSSEC keys); it completes on the next sync |

Prometheus: `GET /v1/server/metrics` includes `dns_cluster_peers{state="connected|failing|joining"}`. Alert when
`failing` stays above zero.

## How it works (for the curious)

Every replicated item has a natural key (`rrset:example.com|www.example.com|A`, `user:dana`…) and is stamped with a hybrid
logical clock when it changes. Nodes keep a numbered log of the latest version of each item and pull "everything after N"
from each peer, relaying what they received from others, so two nodes that cannot reach each other still converge through a
third. A change nudges the peers to pull immediately. The merge is last-writer-wins per item and idempotent, so repeated or
out-of-order delivery is harmless. An item whose parent has not arrived yet (an API key before its user) waits, and is never
mistaken for a deletion. Design and tests are in `dns-server/src/cluster` and `dns-server/test/cluster-*.test.ts`.

To allow only the other nodes to reach the API port, see [Restricting a port to specific IP addresses](DEPLOY.md#restricting-a-port-to-specific-ip-addresses-ubuntu).
