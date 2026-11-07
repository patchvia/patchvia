// How to reach the PowerDNS database. Pure, so it can be tested without a database.

/**
 * Either separate settings (no escaping needed, so any password works) or a mysql:// URL (where special characters in
 * the password must be percent-encoded). Never includes the secret in an error message.
 * @returns {{ok:true, config:object} | {ok:false, error:string}}
 */
export function mysqlConfig(env) {
  if (env.PDNS_MYSQL_HOST) {
    if (!env.PDNS_MYSQL_USER || !env.PDNS_MYSQL_DATABASE) return { ok: false, error: 'PDNS_MYSQL_HOST also needs PDNS_MYSQL_USER and PDNS_MYSQL_DATABASE (and PDNS_MYSQL_PASSWORD).' }
    const port = env.PDNS_MYSQL_PORT ? Number(env.PDNS_MYSQL_PORT) : 3306
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'PDNS_MYSQL_PORT must be a port number.' }
    return { ok: true, config: { host: env.PDNS_MYSQL_HOST, port, user: env.PDNS_MYSQL_USER, password: env.PDNS_MYSQL_PASSWORD ?? '', database: env.PDNS_MYSQL_DATABASE } }
  }
  if (!env.PDNS_MYSQL_URL) return { ok: false, error: 'Set PDNS_MYSQL_HOST, PDNS_MYSQL_USER, PDNS_MYSQL_PASSWORD and PDNS_MYSQL_DATABASE (or PDNS_MYSQL_URL).' }
  const advice =
    'If the password contains characters such as * @ / : # ? % they must be percent-encoded (* is %2A, @ is %40, / is %2F, : is %3A, # is %23, ? is %3F, % is %25).\n' +
    'Easier: leave the URL out and set PDNS_MYSQL_HOST, PDNS_MYSQL_USER, PDNS_MYSQL_PASSWORD and PDNS_MYSQL_DATABASE, which need no escaping.'
  let u
  try {
    u = new URL(env.PDNS_MYSQL_URL)
  } catch {
    return { ok: false, error: `PDNS_MYSQL_URL is not a valid URL. ${advice}` }
  }
  if (u.protocol !== 'mysql:') return { ok: false, error: 'PDNS_MYSQL_URL must start with mysql://' }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  // A raw "/" or "@" in the password does not make the URL invalid: it silently becomes a different host or database name
  if (/[/@]/.test(database) || /[/@]/.test(u.search + u.hash)) return { ok: false, error: `PDNS_MYSQL_URL does not parse as user:password@host/database. ${advice}` }
  if (!u.hostname || !database) return { ok: false, error: 'PDNS_MYSQL_URL needs a host and a database name: mysql://user:password@host:3306/database' }
  return {
    ok: true,
    config: { host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database },
  }
}
