# Coming from PowerDNS?

This page covers moving zones from a PowerDNS server (or any other authoritative server) to Patchvia DNS.

The safe way is to run this server as a **secondary** of the old one, prove it answers identically, and only then
take over. Nothing about the old server changes until the last step, and every step before it is reversible.

## 1. Let this server transfer from the old one

On the old server, allow this server's IP to transfer the zone (PowerDNS: `allow-axfr-ips`, or the zone's
`ALLOW-AXFR-FROM` metadata; BIND: `allow-transfer`). Check the address the old server logs for the request: behind a
Docker Swarm ingress network it is `10.0.0.2` for every client, and allowing that would open transfers to everyone.
Use the database copy below instead.

## 2. Add the zone here as a secondary

Console: **Zones → New zone → Type: Secondary**, primaries = the old server (`ns-old.example.net` or `192.0.2.1:53`).
API: `POST /v1/zones {"name":"example.com","kind":"slave","masters":["192.0.2.1"]}`.
The first transfer starts at once; **Zones → example.com** shows *In sync* with the record count, or the exact reason it
failed (refused, timed out…). Records of types this server does not serve (DNSKEY, RRSIG, TLSA, SSHFP…) are skipped
and counted in the zone's history, so you know before cutting over.

## 3. Prove it matches

```sh
dns-server/scripts/compare-servers.sh example.com old-ns.example.net 198.51.100.5      # record by record
dns-server/scripts/check-zone.sh example.com 198.51.100.5                              # behaviour: flags, NXDOMAIN, TCP, REFUSED
dig @198.51.100.5 www.example.com A                                         # spot checks
```

Query a few real names for each record type you rely on (MX, TXT/SPF, SRV, CAA, wildcards).

If the old zone is DNSSEC-signed, signing keys are not copied: this server generates its own. Switching a signed zone
without updating the DS record at the registrar makes validating resolvers reject it. Either turn DNSSEC off at the registrar
(remove the DS record, wait for its TTL) before the switch and enable it here afterwards, or enable it here first, publish
the new DS next to the old one, and remove the old DS once the NS change has propagated.

## 4. Promote

When the comparison is clean: **Zone → Settings → Promote to primary** (API: `PATCH /v1/zones/example.com {"kind":"master"}`).
It stops transferring, keeps its data, and becomes editable. Serials keep increasing from the transferred value.

## 5. Switch NS records

Change the NS (and glue) records at your registrar to this server, with the registrar's TTLs lowered beforehand.
Keep the old server running until the old TTLs have expired, then retire it.

## If something looks wrong

Before step 4, delete the secondary zone here: nothing was changed anywhere else. After step 5, point the NS records
back to the old server; it still has the zone as it was.

## Many zones at once: copy straight from the PowerDNS database

If PowerDNS uses the MySQL backend (`pschiffe/pdns-mysql`, `gmysql`), `tools/pdns-import` copies every zone without
needing zone transfers. That is the way to go when transfers are awkward, for example when PowerDNS sits behind a Docker
Swarm ingress network, which makes every client look like `10.0.0.2` so no transfer allow-list can name Patchvia. It only
reads from MySQL.

```sh
cd tools/pdns-import && npm install
export PDNS_MYSQL_HOST=data.example.com PDNS_MYSQL_USER=pdns PDNS_MYSQL_DATABASE=powerdns   # a read-only MySQL user is enough
read -rs PDNS_MYSQL_PASSWORD; export PDNS_MYSQL_PASSWORD                                   # type it hidden; any characters work
export PATCHVIA_URL='https://your-patchvia-api'                    # no /v1
export PATCHVIA_API_KEY='dnk_...'                                  # console: API keys, scope "write", admin or operator user

node migrate.mjs                                  # dry run: lists every zone and what would happen
node migrate.mjs --zone example.com               # dry run for one zone
node migrate.mjs --zone example.com --apply       # create it
node migrate.mjs --apply                          # create all of them
```

(`PDNS_MYSQL_URL=mysql://user:password@host/db` also works, but special characters in the password must be percent-encoded
there, which is why separate settings are the easier route.)

It validates every zone with Patchvia's own parser first and never stops at the first problem: the report at the end lists
what needs attention.

- A zone that already exists in Patchvia is skipped; `--overwrite` replaces its records. Running it again is safe.
- Disabled records are not copied (they were not being served). Record types Patchvia does not store (TLSA, SSHFP, ALIAS…)
  are skipped and listed.
- Zones with a record Patchvia rejects (for example an invalid IP address) are reported and left out; fix the record in
  PowerDNS or in Patchvia and run again.
- A zone with no NS records of its own in PowerDNS is flagged. Patchvia needs nameservers for every zone: it uses the
  server's `DEFAULT_NS`, or the ones you give with `--nameservers ns1.example.net,ns2.example.net`. A dry run tells you which
  zones need this before anything is written. (Note that these become the zone's NS records here: they should be the servers
  that will answer for it after the switch.)
- DNSSEC-signed zones are flagged: see the DNSSEC note above before switching their NS records.
- PowerDNS secondary zones are skipped unless you pass `--include-secondary`.
- Who owns which zone in PowerDNS-Admin lives in its own database and is not copied. Use `--account <id>` to put the
  created zones in a Patchvia account, or assign accounts in the console afterwards.

Then continue at step 3 (prove it matches) and carry on as for a transferred zone. The copy is a snapshot: edits made in
PowerDNS afterwards are not carried over, so run it again with `--overwrite` just before the switch, or freeze changes.

## Alternative: a zone file

If you cannot allow transfers, export the zone (`dig AXFR` output, `pdnsutil list-zone`, or BIND's zone file) and use
**Zones → Import**. The preview lists everything that would be imported or skipped, with line numbers for any problem.
