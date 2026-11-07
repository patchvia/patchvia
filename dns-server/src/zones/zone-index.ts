import { isAtOrBelow, parentOf } from '../dns/names.js'
import type { ZoneLookup } from '../dns/resolver.js'
import type { Zone } from './zone.js'

/** Live map of compiled zones. Zones are replaced wholesale, so in-flight queries never see a half-written zone. */
export class ZoneIndex implements ZoneLookup {
  private zones = new Map<string, Zone>()

  set(zone: Zone): void {
    this.zones.set(zone.apex, zone)
  }

  delete(apex: string): void {
    this.zones.delete(apex)
  }

  get size(): number {
    return this.zones.size
  }

  get(apex: string): Zone | undefined {
    return this.zones.get(apex)
  }

  findZone(name: string): Zone | undefined {
    for (let n = name; n !== ''; n = parentOf(n)) {
      const z = this.zones.get(n)
      if (z && isAtOrBelow(name, z.apex)) return z
    }
    return undefined
  }
}
