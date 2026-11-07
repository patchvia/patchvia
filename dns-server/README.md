# dns-server

Authoritative-only DNS server (UDP + TCP) with SQLite-backed zones. See `../docs/DESIGN.md`.

## Status: M5 (DNS core, API, replication, import, DNSSEC, dynamic DNS, clustering)

Implemented: A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, CAA; wildcards (RFC 4592); delegation with glue;
empty non-terminals; CNAME chains; ANY; NXDOMAIN/NODATA with SOA; EDNS0 (1232) and TC fallback to TCP; 0x20
case echo; `REFUSED` for non-hosted zones, AXFR/IXFR (until M3); automatic YYYYMMDDnn serials.
HTTP API (NestJS, `/v1`): login with rate limiting, users with roles (`admin` / `operator` / `user`), accounts with
per-zone access, zones and atomic RRset patching (one transaction, one serial bump), zone-file export, per-zone audit
history with before/after, scoped API keys, server stats and health.
Replication: AXFR and IXFR out (TCP, restricted by `ALLOW_AXFR_FROM`; IXFR is answered as a full transfer or a lone
SOA when the client is current), NOTIFY out to `NOTIFY_TO` with retries, and **secondary zones** that transfer from one
or more primaries, refresh on the SOA timers or on an authenticated NOTIFY, keep serving the last good data when a
primary is down, and can be **promoted** to primary zones. Zone-file import (BIND format, `$ORIGIN`/`$TTL`, multi-line
SOA, relative names) with a dry-run preview, as a new zone or replacing an existing one.
**DNSSEC**: online signing with ECDSA P-256 (algorithm 13) and NSEC denial of existence. Turn it on per zone (API or
console) and give the returned DS record to the registrar. Signatures are made on demand and cached; every answer a
validating resolver can ask for is covered: positive answers, CNAME chains, wildcard expansion, NXDOMAIN (with the
closest-encloser wildcard proof), NODATA, empty non-terminals, and unsigned delegations (including DS queries). Multiple
keys, with publish/activate/delete, support rollover. Signed zones are not transferred to secondaries. Verified against
BIND's `delv`, see "Validating DNSSEC" below. The private keys are in the database: protect and back it up like one.
**Dynamic DNS**: per-name tokens (`ddns_…`, stored hashed, shown once) for `GET|POST /dyn/update?token=…&ip=…` and the
DynDNS2 protocol routers use (`/nic/update?hostname=…&myip=…`, token as the password). Updates that change nothing write
nothing; flapping clients and token guessers are throttled.
**Abuse protection**: UDP response rate limiting (identical responses per client network per second; excess is dropped or
truncated so real clients retry over TCP), TCP connections per address cap, and a Prometheus endpoint at
`GET /v1/server/metrics`.
**Clustering**: several nodes, each with its own database, keep zones, records, users, API keys, dynamic DNS tokens and
DNSSEC keys in sync, with changes accepted on any node and merged last-writer-wins, so every node keeps serving when
others are down. Set `CLUSTER_SECRET`, `CLUSTER_NODE_ID` and `CLUSTER_PEERS`; see `../docs/CLUSTER.md`.
Not yet: TSIG, NSEC3, DS records for delegations. Types we do not serve (DNSKEY, RRSIG, NSEC, TLSA, SSHFP…) are skipped and
counted on transfer and import, never silently.

## API quick start

```sh
# first boot prints the generated admin password once (or set ADMIN_PASSWORD)
TOKEN=$(curl -s :8081/v1/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"..."}' | jq -r .token)
curl :8081/v1/zones -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"example.com","nameservers":["ns1.example.com"],"rrsets":[{"name":"@","type":"A","ttl":300,"records":[{"content":"192.0.2.1"}]}]}'
curl -X PATCH :8081/v1/zones/example.com/rrsets -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rrsets":[{"name":"www.example.com","type":"CNAME","ttl":300,"records":[{"content":"example.com"}]}]}'
```

Routes: `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`; `GET|POST /zones`, `GET|PATCH|DELETE /zones/:name`,
`PATCH /zones/:name/rrsets` (`changetype` `REPLACE`|`DELETE`, `"@"` = apex), `GET /zones/:name/export|history`;
`/users`, `/accounts`, `/api-keys`; `GET /server/stats`, `GET /server/health` (public).
Auth: `Authorization: Bearer <jwt|key>` or `X-API-Key`. API keys (`dnk_…`) act as their owner within `read`/`write`
scope and can never manage users, keys or passwords. Users with role `user` only see zones of their accounts
(others return 404, not 403).

## Run

```sh
npm install
npm run seed                      # creates example.test in ./data/dns.db
DNS_PORT=5300 DNS_HOST=127.0.0.1 npm run dev
dig @127.0.0.1 -p 5300 example.test MX
npm test
```

macOS note: port 5353 is taken by mDNS, so use another dev port.

Env: `DNS_HOST` (`::`), `DNS_PORT` (53), `API_HOST` (`0.0.0.0`), `API_PORT` (8081), `DB_PATH` (`./data/dns.db`),
`ADMIN_PASSWORD` (first boot only), `JWT_SECRET` (≥32 chars; generated and stored if unset), `SESSION_HOURS` (12),
`DEFAULT_NS` (comma list used when a zone is created without nameservers), `ALLOW_AXFR_FROM` (addresses or CIDRs allowed
to transfer zones, e.g. `203.0.113.7,10.0.0.0/8`; empty disables transfers), `NOTIFY_TO` (secondaries to notify on every
change, `host` or `host:port`, comma separated), `RRL_RESPONSES_PER_SECOND` (default 20, 0 = off), `RRL_SLIP` (default 2),
`RRL_EXEMPT` (CIDRs never limited, default `127.0.0.1,::1`), `TCP_MAX_PER_IP` (default 50), `CLUSTER_SECRET` / `CLUSTER_NODE_ID` / `CLUSTER_PEERS` / `CLUSTER_ALLOW_FROM` /
`CLUSTER_SYNC_SECONDS` (default 10) for cluster mode.

## Validating with dig

```sh
# the whole battery on one zone (SOA, aa/ra flags, NXDOMAIN/NODATA/REFUSED, case, TCP, AXFR)
scripts/check-zone.sh example.com 127.0.0.1 5300

# by hand
dig @127.0.0.1 -p 5300 example.com SOA +norecurse        # status NOERROR, flags include aa, no ra
dig @127.0.0.1 -p 5300 www.example.com A                 # CNAME chain followed in the answer
dig @127.0.0.1 -p 5300 nope.example.com A                # NXDOMAIN with the SOA in authority
dig @127.0.0.1 -p 5300 example.org A                     # REFUSED: not hosted here
dig @127.0.0.1 -p 5300 +tcp example.com AXFR             # NOERROR if ALLOW_AXFR_FROM covers you, else REFUSED
dig @127.0.0.1 -p 5300 +bufsize=512 example.com ANY      # tc flag appears only if it does not fit

# prove two servers are identical before switching NS records (ignores order, case and the SOA serial)
scripts/compare-servers.sh example.com old-ns.example.net:53 127.0.0.1:5300
```

Replication, checked from outside: after a change on a primary the secondary's serial in
`dig +short @secondary zone SOA` catches up within seconds when `NOTIFY_TO` points at it, or within the SOA refresh
interval otherwise. A secondary whose primary is down keeps answering with its last data and shows the error in the console.

## Validating DNSSEC

After enabling DNSSEC the API returns the DS record. To check it the way a validating resolver would, use BIND's `delv`
with the zone's key as the trust anchor (it needs `+root=` set to the zone):

```sh
# anchor: the DNSKEY from GET /v1/zones/example.com/dnssec  (keys[0].dnskey = "257 3 13 <base64>")
echo 'trust-anchors { "example.com." static-key 257 3 13 "<base64>"; };' > anchor.conf
delv @127.0.0.1 -p 5300 -a anchor.conf +root=example.com example.com A        # ; fully validated
delv @127.0.0.1 -p 5300 -a anchor.conf +root=example.com nope.example.com A   # negative response, fully validated
dig  @127.0.0.1 -p 5300 +dnssec example.com DNSKEY                            # key, RRSIG, ad is for resolvers only
dnssec-dsfromkey -2 -f dnskey.txt example.com.                               # BIND's DS must equal the API's
```

If `delv` is not installed: `docker run --rm alpine sh -c 'apk add bind-tools && delv …'` (use `host.docker.internal`
for the server). A wrong key must make it fail, which is how you know it is really validating.

## Dynamic DNS

```sh
# create a token for home.example.com (shown once), then from the device:
curl "https://dns.example.com/dyn/update?token=ddns_…"             # uses the caller's address
curl "https://dns.example.com/dyn/update?token=ddns_…&ip=203.0.113.5&ip6=2001:db8::5"
curl -u ddns:ddns_… "https://dns.example.com/nic/update?hostname=home.example.com&myip=203.0.113.5"   # DynDNS2
```

## Layout

- `src/dns/` wire codec, rdata encoding, **pure resolver** (`resolver.ts`), packet handler, UDP/TCP listeners
- `src/zones/` compiled `Zone`, live `ZoneIndex`, `ZoneService` (validation, serial bumps), SQLite repository
- `src/db/` connection + migrations
- `src/auth/`, `src/users/` authentication, guard, roles, users, accounts, API keys
- `src/zones/zones.controller.ts`, `src/server/` HTTP endpoints; `src/app.module.ts` wiring

## Future: Go rewrite of the query path

The hot path is deliberately isolated so it can be replaced with a Go implementation if throughput demands it:

- `src/dns/resolver.ts` + `codec.ts` + `rdata.ts` are pure (no I/O) and are the only parts that would be ported.
- Zones are handed to the resolver as pre-compiled, immutable structures with pre-encoded wire rdata, so a Go
  process could load the same data (from SQLite read-only, or pushed by the API) and serve it.
- The zone management API, auth, audit and console stay TypeScript; the query server would become a sidecar that
  reads the same database, with `test/resolver.test.ts` and the `dig` matrix as the conformance suite.

## Commands

`node dist/cli.js reset-password <username> [--generate | --password-stdin]` sets a new password straight in the database for
when nobody can sign in. See [docs/DEPLOY.md](../docs/DEPLOY.md#forgot-a-password).
