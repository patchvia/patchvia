/** Next SOA serial in YYYYMMDDnn form; always strictly greater than `current`. */
export function nextSerial(current: number, now: Date = new Date()): number {
  const base =
    now.getUTCFullYear() * 1_000_000 + (now.getUTCMonth() + 1) * 10_000 + now.getUTCDate() * 100
  return current >= base ? current + 1 : base
}

/** RFC 1982 serial number arithmetic: is `a` newer than `b`? */
export function serialGt(a: number, b: number): boolean {
  const half = 2 ** 31
  return (a < b && b - a > half) || (a > b && a - b < half)
}
