import { isIPv6 } from 'node:net'
import { ValidationError } from '../dns/names.js'

export interface PeerAddress {
  /** Base URL of the peer's API, no trailing slash */
  url: string
  host: string
  /** For display and as the key in the database */
  label: string
}

/** "ns2.example.com", "203.0.113.5:8081", "[2001:db8::1]:8081" or "https://ns2.example.com:8443". */
export function parsePeerAddress(input: string, defaultPort: number): PeerAddress {
  const raw = input.trim()
  const bad = () => new ValidationError(`"${input}" is not a valid peer address (use host, host:port or https://host:port)`)
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    throw bad()
  }
  if (!u.hostname || u.pathname !== '/' || u.search || u.username) throw bad()
  const host = u.hostname.replace(/^\[|\]$/g, '')
  // URL drops an explicit default port (":80"), so read it from the text we were given
  const explicit = /:(\d{1,5})\/?$/.exec(raw)?.[1]
  const port = explicit ?? (/^https:\/\//i.test(raw) ? '443' : String(defaultPort))
  if (Number(port) < 1 || Number(port) > 65535) throw bad()
  const bracketed = isIPv6(host) ? `[${host}]` : host
  return { url: `${u.protocol}//${bracketed}:${port}`, host, label: `${bracketed}:${port}` }
}
