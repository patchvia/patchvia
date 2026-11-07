import { isIPv4, isIPv6 } from 'node:net'
import { ValidationError } from '../dns/names.js'

export interface Target {
  host: string
  port: number
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i

/** "ns1.example.net", "192.0.2.1:5353", "[2001:db8::1]:53" or a bare IPv6 literal. Default port 53. */
export function parseTarget(input: string): Target {
  const s = input.trim()
  const bad = () => new ValidationError(`"${input}" is not a valid host or host:port`)
  let host = s
  let port = 53
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (bracket) {
    host = bracket[1]!
    if (bracket[2] !== undefined) port = Number(bracket[2])
    if (!isIPv6(host)) throw bad()
  } else if (isIPv6(s)) {
    host = s
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(s)
    if (!m) throw bad()
    host = m[1]!
    if (m[2] !== undefined) port = Number(m[2])
    if (!isIPv4(host) && !HOSTNAME.test(host)) throw bad()
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad()
  return { host: host.replace(/\.$/, ''), port }
}

export const formatTarget = (t: Target) => (t.host.includes(':') ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`)
