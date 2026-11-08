# Patchvia DNS

DNS infrastructure, simplified. Patchvia DNS is an authoritative DNS server with a web console. You run it on your own
servers, and manage zones, records, DNSSEC keys, dynamic DNS and replication from the console or the API.

- **Server** (`dns-server`): answers DNS over UDP and TCP, with an HTTP API for everything else. Supported record types
  are A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, PTR and SOA, with wildcards and delegation. It also does zone transfers
  (AXFR and IXFR) and NOTIFY, secondary zones, zone-file import, DNSSEC online signing with key rollover, dynamic DNS
  updates, rate limiting, and clustering: several nodes, each with its own database, that keep each other in sync.
- **Console** (`dns-console`): a web UI for all of it. Zones and a staged record editor, users and accounts, API keys,
  DNSSEC, dynamic DNS tokens, replication status and cluster health.

## Layout

```
dns-server/    NestJS API + DNS server (TypeScript, SQLite), Dockerfile, tests, operator scripts
dns-console/   Next.js console (Tailwind, shadcn/Radix), Dockerfile, tests
docs/          Public documentation: DEPLOY.md, CLUSTER.md, migration/
tools/         pdns-import: copy zones from a PowerDNS MySQL database
deploy/        docker-compose.yml and .env.example
.github/       CI
```

The packages are independent: each has its own `package.json`, lockfile and image.

## Run it

```sh
cd deploy
cp .env.example .env          # set ADMIN_PASSWORD and SESSION_SECRET (32+ characters)
docker compose up -d --build  # builds from this checkout
```

Images: [dns-server](https://github.com/patchvia/patchvia/pkgs/container/dns-server) and [dns-console](https://github.com/patchvia/patchvia/pkgs/container/dns-console), for `linux/amd64` and `linux/arm64`.

On a server, use the published images instead (`docker compose pull && docker compose up -d --no-build`); see
[docs/DEPLOY.md](docs/DEPLOY.md).

- Console: <http://localhost:3000>, sign in as `admin` with `ADMIN_PASSWORD`.
- DNS: port 53 (UDP and TCP). API: port 8081, bound to localhost by default. On Ubuntu, `systemd-resolved` usually holds
  port 53 already: see [Port 53 on an Ubuntu server](docs/DEPLOY.md#port-53-on-an-ubuntu-server).

Try it: create a zone in the console, then `dig @127.0.0.1 www.example.com`. For port conflicts and the other settings,
see the comments in `deploy/.env.example`.

Coming from another DNS server? See [Coming from PowerDNS?](docs/migration/from-powerdns.md) for moving zones across.

## Develop

```sh
npm run install:all      # install all packages
npm run check            # typecheck + all tests
npm run docker:build     # build the images
```

Run the pieces on their own with the instructions in `dns-server/README.md`, `dns-console/README.md` and `site/README.md`.
Node 22 or newer.

## Documentation

| | |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Images, running on a server, firewall, releasing |
| [docs/CLUSTER.md](docs/CLUSTER.md) | Running several nameservers that stay in sync |
| [docs/migration/from-powerdns.md](docs/migration/from-powerdns.md) | Moving zones from PowerDNS or another server |
| [dns-server/README.md](dns-server/README.md) | Server features, settings, validating with `dig` and `delv` |

## Security

The server's database contains DNSSEC private keys, password hashes and cluster state: protect and back it up like a
secret. Keep `.env` files out of version control (they are ignored). The API port should not be open to the internet
without TLS in front of it. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Patchvia DNS is licensed under the [Apache License 2.0](LICENSE). Issues and ideas are welcome. Pull requests are not
being accepted yet: see [CONTRIBUTING.md](CONTRIBUTING.md). Copyright 2026 Floms, Inc. See [NOTICE](NOTICE).

## Sponsor

Patchvia DNS is sponsored by [Floms](https://www.floms.com).
