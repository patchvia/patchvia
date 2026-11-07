import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mysqlConfig } from './connection.mjs'

test('separate settings take any password as it is', () => {
  const r = mysqlConfig({ PDNS_MYSQL_HOST: 'db.example.com', PDNS_MYSQL_USER: 'pdns', PDNS_MYSQL_PASSWORD: 'S*p@ss/w:rd#?%', PDNS_MYSQL_DATABASE: 'powerdns' })
  assert.deepEqual(r, { ok: true, config: { host: 'db.example.com', port: 3306, user: 'pdns', password: 'S*p@ss/w:rd#?%', database: 'powerdns' } })
})

test('a URL works, with the password percent-decoded', () => {
  const r = mysqlConfig({ PDNS_MYSQL_URL: 'mysql://root:S%2Ap%40ss@host.example:3307/powerdns' })
  assert.deepEqual(r.config, { host: 'host.example', port: 3307, user: 'root', password: 'S*p@ss', database: 'powerdns' })
})

test('a URL with a raw special character gives advice and never repeats the password', () => {
  const secret = 'S*up3r:secret@pw/x'
  const r = mysqlConfig({ PDNS_MYSQL_URL: `mysql://root:${secret}@host/db` })
  assert.equal(r.ok, false)
  assert.match(r.error, /percent-encoded/)
  assert.match(r.error, /PDNS_MYSQL_HOST/)
  assert.ok(!r.error.includes('secret'))
})

test('missing or incomplete settings are explained', () => {
  assert.match(mysqlConfig({}).error, /PDNS_MYSQL_HOST/)
  assert.match(mysqlConfig({ PDNS_MYSQL_HOST: 'h' }).error, /PDNS_MYSQL_USER/)
  assert.match(mysqlConfig({ PDNS_MYSQL_HOST: 'h', PDNS_MYSQL_USER: 'u', PDNS_MYSQL_DATABASE: 'd', PDNS_MYSQL_PORT: 'x' }).error, /port/)
  assert.match(mysqlConfig({ PDNS_MYSQL_URL: 'http://h/db' }).error, /mysql:\/\//)
})
