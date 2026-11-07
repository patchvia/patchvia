import { Logger } from '@nestjs/common'
import { encodeNotify } from '../dns/codec.js'
import { decodeMessage } from '../dns/decode.js'
import { OpCode, RCode } from '../dns/types.js'
import type { ReplicationIO } from './io.js'
import { formatTarget, type Target } from './target.js'

export interface NotifierOptions {
  /** Changes arriving within this window are coalesced into one NOTIFY */
  debounceMs: number
  /** Waits before each retry when a secondary does not answer */
  retryDelaysMs: number[]
  timeoutMs: number
}

const DEFAULTS: NotifierOptions = { debounceMs: 300, retryDelaysMs: [5_000, 30_000, 120_000], timeoutMs: 2_000 }

export interface NotifyResult {
  target: string
  acked: boolean
}

/** Tells secondaries a zone changed (RFC 1996) and retries when they do not answer. */
export class Notifier {
  private readonly log = new Logger('Notify')
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly opts: NotifierOptions

  constructor(
    private readonly targets: Target[],
    private readonly io: Pick<ReplicationIO, 'sendNotify'>,
    opts: Partial<NotifierOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  get targetNames(): string[] {
    return this.targets.map(formatTarget)
  }

  /** Debounced, fire-and-forget: called after every committed zone change. */
  schedule(zone: string): void {
    if (this.targets.length === 0) return
    clearTimeout(this.timers.get(zone))
    this.timers.set(
      zone,
      setTimeout(() => {
        this.timers.delete(zone)
        void Promise.all(this.targets.map((t) => this.withRetries(t, zone)))
      }, this.opts.debounceMs).unref(),
    )
  }

  /** One immediate attempt per target, for the "send NOTIFY now" button. */
  async notifyNow(zone: string): Promise<NotifyResult[]> {
    return Promise.all(this.targets.map(async (t) => ({ target: formatTarget(t), acked: (await this.once(t, zone)) === 'acked' })))
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private async once(target: Target, zone: string): Promise<'acked' | 'rejected' | 'silent'> {
    const id = Math.floor(Math.random() * 65536)
    let reply: Buffer | null
    try {
      reply = await this.io.sendNotify(target, encodeNotify(id, zone), this.opts.timeoutMs)
    } catch {
      reply = null
    }
    if (!reply) return 'silent'
    try {
      const m = decodeMessage(reply)
      if (m.id !== id || m.opcode !== OpCode.NOTIFY) return 'silent'
      return m.rcode === RCode.NOERROR ? 'acked' : 'rejected'
    } catch {
      return 'silent'
    }
  }

  private async withRetries(target: Target, zone: string): Promise<void> {
    const name = formatTarget(target)
    for (let attempt = 0; attempt <= this.opts.retryDelaysMs.length; attempt++) {
      const r = await this.once(target, zone)
      if (r === 'acked') return
      if (r === 'rejected') {
        this.log.warn(`${name} rejected NOTIFY for ${zone}; it is not configured as a secondary of this server`)
        return
      }
      const wait = this.opts.retryDelaysMs[attempt]
      if (wait === undefined) break
      await new Promise((res) => setTimeout(res, wait).unref())
    }
    this.log.warn(`${name} never acknowledged NOTIFY for ${zone}; it will catch up on its next refresh`)
  }
}
