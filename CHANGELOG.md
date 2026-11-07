# Changelog

All notable changes to Patchvia DNS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Anything a user would notice goes here. Each release gets a `## X.Y.Z` heading.

## 0.1.0 - 2026-11-07

### Added

- Authoritative DNS over UDP and TCP: A, AAAA, CNAME, MX, NS, TXT, SRV, CAA, PTR and SOA records, with wildcards and
  delegation.
- Zone transfers (AXFR and IXFR), NOTIFY, secondary zones and zone-file import and export.
- DNSSEC online signing with key rollover, and DS records for the registrar in the console.
- Dynamic DNS: per-zone tokens and the update protocols that routers and gateways use.
- Clustering: several nodes, each with its own database, kept in sync with a shared secret.
- Web console: a dashboard, zones, a staged record editor, zone history, accounts, users with roles, and API keys.
- Response rate limiting and a per-address limit on TCP connections.
- Docker Compose deployment: the DNS server and the console as two images.
