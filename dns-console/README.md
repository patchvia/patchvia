# dns-console

Web console for `dns-server` (Next.js 16, Tailwind 4, shadcn/Radix, TanStack Query).
It talks only to the DNS API; the API token lives in a sealed, httpOnly cookie and never reaches the browser.

## Features

- **Dashboard** (admin/operator): zones, records, queries answered, uptime, query-type and response-code breakdowns
  (each with a table view), recent changes across all zones.
- **Zones**: filterable list, create with default nameservers, account assignment, zone-file export, delete with typed confirmation.
- **Record editor**: A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, PTR with per-type fields and inline validation that mirrors
  the server (including the CNAME rules); edits are **staged** and applied as **one atomic change** after a
  `+`/`-` review; add, edit, disable, delete (with undo), bulk disable/enable/delete, search and type filter, SOA
  settings with an automatic serial, unsaved-changes warning.
- **History**: per-zone audit log with before/after diffs.
- **Users and accounts** (admin): roles (administrator / operator / user), per-account zone access, password reset and generator.
- **API keys**: read or read-and-write scope, shown once, revocable, with a ready-to-run `curl` example.
- **Security**: change password (other sessions are signed out, this one stays).
- **DNSSEC** (zone Settings): one-click signing, the DS record to give your registrar with copy buttons (SHA-256 and
  SHA-384), DNSKEY, key list with add/start/stop/delete for rollover, and a guarded "turn off" that makes you confirm the
  DS record is gone.
- **Dynamic DNS** (zone Settings): per-hostname tokens shown once, with ready-to-paste `ddclient`, router and `curl`
  settings; last address and last use per token; revoke.
- **Cluster** (admin): node and peer health, last contact and problems, "Sync now", and a dashboard warning when a node is unreachable.
- **Replication**: secondary zones (read-only, with transfer status), promote to primary, zone-file import with preview,
  NOTIFY, transfer settings.
- Command palette (⌘K, `/` pages, `#` zones, `>` actions), light/dark following the system, responsive layout.

## Run

```sh
cp .env.example .env.local      # DNS_API_URL, SESSION_SECRET (32+ chars)
npm install
npm run dev                     # http://localhost:4301
npm test                        # editor logic, validation, formatting, navigation
```

| Variable | Meaning |
| --- | --- |
| `DNS_API_URL` | Where the console server reaches the API, e.g. `http://dns-server:8081` |
| `DNS_PUBLIC_API_URL` | How automation reaches it (shown in API key examples). Defaults to `DNS_API_URL` |
| `SESSION_SECRET` / `SESSION_SECRET_FILE` | 32+ characters sealing the session cookie |
| `SESSION_HOURS` | Session length, default 8 |

The product name is one constant: `src/lib/brand.ts`.
