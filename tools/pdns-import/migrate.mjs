#!/usr/bin/env node
// Copies zones from a PowerDNS gmysql database into Patchvia DNS through its import API.
// Read-only against MySQL. Without --apply it only reports what would happen (a dry run on Patchvia's side too).
import { parseArgs } from 'node:util'
import mysql from 'mysql2/promise'
import { mysqlConfig } from './connection.mjs'
import { buildZoneFile } from './convert.mjs'

const HELP = `Usage: node migrate.mjs [options]

Connection (environment variables, so secrets stay out of shell history and process lists):
  PDNS_MYSQL_HOST, PDNS_MYSQL_USER, PDNS_MYSQL_PASSWORD, PDNS_MYSQL_DATABASE, and optionally PDNS_MYSQL_PORT (3306)
                      the PowerDNS database. Any password works as it is.
  PDNS_MYSQL_URL      alternative to the four above: mysql://user:password@host:3306/database. Special characters in the
                      password (* @ / : # ? %) must be percent-encoded there, which is why the separate settings are easier.
  PATCHVIA_URL        base URL of the Patchvia API, for example https://dns-api.example.com  (no /v1)
  PATCHVIA_API_KEY    an API key (dnk_...) of an admin or operator user

Options:
  --zone <name>       only this zone (repeat for several). Default: every zone in the database
  --apply             actually create the zones. Without it nothing is written anywhere
  --overwrite         replace the records of zones that already exist in Patchvia (default: skip them)
  --include-secondary also create PowerDNS secondary zones, as secondaries of the same primaries
  --account <id>      assign the created zones to this Patchvia account
  --nameservers a,b   nameservers for zones that have no NS records of their own (default: the server's DEFAULT_NS)
  --help
`

const { values: o } = parseArgs({
  options: {
    zone: { type: 'string', multiple: true },
    apply: { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false },
    'include-secondary': { type: 'boolean', default: false },
    account: { type: 'string' },
    nameservers: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})
if (o.help) {
  console.log(HELP)
  process.exit(0)
}
for (const v of ['PATCHVIA_URL', 'PATCHVIA_API_KEY']) {
  if (!process.env[v]) {
    console.error(`Missing ${v}.\n\n${HELP}`)
    process.exit(2)
  }
}
const api = process.env.PATCHVIA_URL.replace(/\/+$/, '') + '/v1'
const accountId = o.account === undefined ? undefined : Number(o.account)
if (accountId !== undefined && !Number.isInteger(accountId)) {
  console.error('--account must be a number')
  process.exit(2)
}

const nameservers = o.nameservers ? o.nameservers.split(',').map((n) => n.trim()).filter(Boolean) : undefined

async function call(method, path, body) {
  console.log(api + path);
  const res = await fetch(api + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.PATCHVIA_API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${json?.message ?? json?.error ?? text.slice(0, 200)}`)
  return json
}

const wanted = o.zone?.length ? new Set(o.zone.map((z) => z.toLowerCase().replace(/\.$/, ''))) : null
const conn = mysqlConfig(process.env)
if (!conn.ok) {
  console.error(conn.error)
  process.exit(2)
}
let db
try {
  db = await mysql.createConnection(conn.config)
} catch (e) {
  // the driver's message names the host and user but never the password
  console.error(`Could not connect to MySQL at ${conn.config.host}:${conn.config.port}: ${e.code ?? ''} ${e.message}`)
  process.exit(2)
}
await db.query('SET SESSION TRANSACTION READ ONLY')

const [domains] = await db.query('SELECT id, name, type, master FROM domains ORDER BY name')
let signed = new Set()
try {
  const [keys] = await db.query('SELECT DISTINCT domain_id FROM cryptokeys WHERE active = 1')
  signed = new Set(keys.map((k) => k.domain_id))
} catch {
  // no cryptokeys table: DNSSEC was never enabled
}

const existing = new Set((await call('GET', '/zones')).map((z) => z.name.toLowerCase().replace(/\.$/, '')))
const found = new Set(domains.map((d) => d.name.toLowerCase()))
for (const w of wanted ?? []) if (!found.has(w)) console.error(`! ${w} is not in the PowerDNS database`)

const tally = { created: 0, replaced: 0, wouldCreate: 0, skipped: 0, failed: 0 }
const attention = []
console.log(o.apply ? 'APPLYING changes to Patchvia.\n' : 'DRY RUN: nothing will be written. Add --apply to create the zones.\n')

for (const d of domains) {
  const name = d.name.toLowerCase().replace(/\.$/, '')
  if (wanted && !wanted.has(name)) continue
  const tag = `${name}`.padEnd(40)
  try {
    if (d.type === 'SLAVE') {
      if (!o['include-secondary']) {
        console.log(`${tag} skipped: secondary zone in PowerDNS (use --include-secondary)`)
        tally.skipped++
        continue
      }
      if (existing.has(name)) {
        console.log(`${tag} skipped: already in Patchvia`)
        tally.skipped++
        continue
      }
      const masters = String(d.master ?? '').split(/[,\s]+/).filter(Boolean)
      if (!masters.length) throw new Error('secondary zone with no primaries listed')
      if (o.apply) await call('POST', '/zones', { name, kind: 'slave', masters, accountId })
      console.log(`${tag} ${o.apply ? 'created' : 'would create'} as a secondary of ${masters.join(', ')}`)
      o.apply ? tally.created++ : tally.wouldCreate++
      continue
    }

    const exists = existing.has(name)
    if (exists && !o.overwrite) {
      console.log(`${tag} skipped: already in Patchvia (use --overwrite to replace its records)`)
      tally.skipped++
      continue
    }
    const [rows] = await db.query('SELECT name, type, content, ttl, prio, disabled FROM records WHERE domain_id = ?', [d.id])
    const built = buildZoneFile(name, rows)
    const req = { zonefile: built.zonefile, name, mode: exists ? 'replace' : 'create', kind: 'native', accountId, nameservers }
    const dry = await call('POST', '/zones/import', { ...req, dryRun: true })

    const notes = []
    if (!built.apexNs) {
      const found = Object.entries(built.types).map(([t, n]) => `${t} x${n}`).join(', ') || 'nothing'
      notes.push(`no NS records at the zone apex in PowerDNS (it has: ${found}); ${exists ? 'its current NS records in Patchvia are kept' : nameservers ? `Patchvia will use ${nameservers.join(', ')}` : "Patchvia will use the server's DEFAULT_NS, or refuse the zone if none is set (pass --nameservers)"}`)
    }
    if (built.disabled) notes.push(`${built.disabled} disabled record${built.disabled > 1 ? 's' : ''} not copied`)
    for (const u of built.unusable) notes.push(`unusable record dropped: ${u}`)
    const skippedTypes = Object.entries(dry.skipped ?? {}).map(([t, n]) => `${t} x${n}`)
    if (skippedTypes.length) notes.push(`not supported by Patchvia, skipped: ${skippedTypes.join(', ')}`)
    for (const w of dry.warnings ?? []) notes.push(w)
    if (signed.has(d.id)) notes.push('DNSSEC-signed in PowerDNS: keys are not copied, see docs/MIGRATION.md before switching NS')

    if (!dry.ok) {
      console.log(`${tag} FAILED validation: ${dry.problems.join('; ')}`)
      tally.failed++
      attention.push([name, ['validation failed: ' + dry.problems.join('; '), ...notes]])
      continue
    }
    const summary = `${dry.records} records in ${dry.rrsets} sets`
    if (o.apply) {
      await call('POST', '/zones/import', { ...req, dryRun: false })
      console.log(`${tag} ${exists ? 'replaced' : 'created'}: ${summary}`)
      exists ? tally.replaced++ : tally.created++
    } else {
      console.log(`${tag} would ${exists ? 'replace' : 'create'}: ${summary}`)
      tally.wouldCreate++
    }
    if (notes.length) attention.push([name, notes])
  } catch (e) {
    console.log(`${tag} FAILED: ${e.message}`)
    tally.failed++
    attention.push([name, [e.message]])
  }
}
await db.end()

if (attention.length) {
  console.log('\nNeeds your attention:')
  for (const [name, notes] of attention) for (const n of notes) console.log(`  ${name}: ${n}`)
}
console.log(
  `\n${o.apply ? `created ${tally.created}, replaced ${tally.replaced}` : `would create or replace ${tally.wouldCreate}`}, skipped ${tally.skipped}, failed ${tally.failed}`,
)
process.exit(tally.failed ? 1 : 0)
