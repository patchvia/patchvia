/**
 * Hybrid logical clock (Kulkarni et al.): timestamps that follow wall-clock time but never go backwards, and that order
 * an effect after its cause even when nodes' clocks disagree. Formatted so plain string comparison orders them:
 * "<12 hex digits of ms>.<4 hex digits of counter>.<node id>".
 */
export interface HlcStamp {
  ms: number
  counter: number
  node: string
}

const MS_WIDTH = 12
const COUNTER_WIDTH = 4
const MAX_COUNTER = 0xffff

export function formatHlc(s: HlcStamp): string {
  return `${s.ms.toString(16).padStart(MS_WIDTH, '0')}.${s.counter.toString(16).padStart(COUNTER_WIDTH, '0')}.${s.node}`
}

export function parseHlc(text: string): HlcStamp | undefined {
  const m = /^([0-9a-f]{12})\.([0-9a-f]{4})\.([a-z0-9][a-z0-9._-]{0,62})$/.exec(text)
  return m ? { ms: parseInt(m[1]!, 16), counter: parseInt(m[2]!, 16), node: m[3]! } : undefined
}

/** > 0 when a is later than b. Ties (same instant) are broken by node id so every node picks the same winner. */
export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export class HlcClock {
  private ms = 0
  private counter = 0

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
    /** Resume after a restart so time never goes back, even if the system clock was set earlier */
    resumeFrom?: string,
  ) {
    const r = resumeFrom ? parseHlc(resumeFrom) : undefined
    if (r) {
      this.ms = r.ms
      this.counter = r.counter
    }
  }

  /** A stamp for something that happens here now. */
  tick(): string {
    const wall = this.now()
    if (wall > this.ms) {
      this.ms = wall
      this.counter = 0
    } else {
      this.counter++
      if (this.counter > MAX_COUNTER) {
        // 65k events in one millisecond: borrow the next millisecond rather than overflow
        this.ms++
        this.counter = 0
      }
    }
    return this.last()
  }

  /** Take in a stamp from another node so our next stamp is later than it. */
  observe(remote: string): void {
    const r = parseHlc(remote)
    if (!r) return
    const wall = this.now()
    const ms = Math.max(this.ms, r.ms, wall)
    if (ms === this.ms && ms === r.ms) this.counter = Math.max(this.counter, r.counter) + 1
    else if (ms === this.ms) this.counter++
    else if (ms === r.ms) this.counter = r.counter + 1
    else this.counter = 0
    this.ms = ms
    if (this.counter > MAX_COUNTER) {
      this.ms++
      this.counter = 0
    }
  }

  last(): string {
    return formatHlc({ ms: this.ms, counter: this.counter, node: this.node })
  }

  /** True when `remote` is so far ahead of our wall clock that accepting it would poison ordering (a node with a wrong clock). */
  isImplausible(remote: string, maxAheadMs = 24 * 3600_000): boolean {
    const r = parseHlc(remote)
    return !r || r.ms > this.now() + maxAheadMs
  }
}
