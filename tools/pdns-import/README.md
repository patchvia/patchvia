# pdns-import

Copies zones from a PowerDNS MySQL database (`gmysql` backend, for example `pschiffe/pdns-mysql`) into Patchvia DNS. It only
reads from MySQL, dry-runs unless you pass `--apply`, and is safe to run again. The full walkthrough, including what is
and is not copied, is in [docs/MIGRATION.md](../../docs/MIGRATION.md).

```sh
npm install
PDNS_MYSQL_HOST=host PDNS_MYSQL_USER=user PDNS_MYSQL_PASSWORD=... PDNS_MYSQL_DATABASE=powerdns PATCHVIA_URL=https://your-api PATCHVIA_API_KEY=dnk_... node migrate.mjs --help
npm test      # the converter's unit tests
```

How it works: each zone's rows become a zone file (`convert.mjs`, no I/O), which Patchvia's import endpoint parses and
validates, so a zone is accepted by exactly the rules the console's Import uses.
