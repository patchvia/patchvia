import { RType } from '../dns/types.js'

const TYPE_ORDER: number[] = [RType.SOA, RType.NS, RType.A, RType.AAAA, RType.CNAME, RType.MX, RType.TXT, RType.SRV, RType.CAA, RType.PTR]

/** Stable presentation order: apex first, then names alphabetically, then a conventional type order. */
export function compareZoneOrder(a: { name: string; type: number }, b: { name: string; type: number }, apex: string): number {
  if (a.name !== b.name) {
    if (a.name === apex) return -1
    if (b.name === apex) return 1
    return a.name < b.name ? -1 : 1
  }
  const ra = TYPE_ORDER.indexOf(a.type)
  const rb = TYPE_ORDER.indexOf(b.type)
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
}
