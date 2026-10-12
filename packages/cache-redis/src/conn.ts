// A Bun RedisClient with an adapter-owned reconnect loop (cache-redis R8): the client itself never
// reconnects and never queues offline, so a dead server fails commands at once instead of pinning
// a worker slot until the get budget. A fresh client per attempt (a closed one is not reusable).
import { RedisClient } from 'bun'
import type { ResolvedOptions } from './options'
import { redact } from './redact'

export class Link {
  private client: RedisClient | null = null
  private closing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private fails = 0
  private warned = 0
  /** Reconnect attempts started (a test hook: stable once `close()` ran). */
  reconnects = 0

  constructor(
    private readonly o: ResolvedOptions,
    private readonly what: string,
    /** Runs on every successful connect (subscribe + gap check); a throw drops the connection and retries. */
    private readonly onUp?: (c: RedisClient) => Promise<void>,
    /** Runs when a live connection is lost. */
    private readonly onDown?: () => void,
  ) {}

  get connected(): boolean {
    return this.client !== null
  }

  /** The live client; throws at once when disconnected. */
  get c(): RedisClient {
    if (!this.client) throw new Error(`cache-redis: not connected to ${redact(this.o.url)}`)
    return this.client
  }

  /** One bounded connect; a failure starts the loop. Never throws for network reasons (R9). */
  async start(): Promise<void> {
    if (!(await this.attempt())) this.schedule()
  }

  /** Close the socket as a network loss would (the loop reconnects). */
  drop(): void {
    const cl = this.client
    if (cl) {
      cl.close()
      this.lost(cl)
    }
  }

  close(): void {
    this.closing = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const cl = this.client
    this.client = null
    cl?.close()
  }

  private async attempt(): Promise<boolean> {
    const { url, tls, connectTimeoutMs } = this.o
    const cl = new RedisClient(url, { autoReconnect: false, enableOfflineQueue: false, connectionTimeout: connectTimeoutMs, ...(tls ? { tls } : {}) })
    cl.onclose = (e) => {
      if (this.client === cl) this.lost(cl, e)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cl.connect(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('connect timed out')), connectTimeoutMs)
        }),
      ])
      clearTimeout(timer)
      if (this.closing) {
        cl.close()
        return true
      }
      this.client = cl
      await this.onUp?.(cl)
      this.fails = 0
      this.warned = 0
      return true
    } catch (e) {
      clearTimeout(timer)
      if (this.client === cl) this.client = null
      cl.close()
      this.warn(e)
      return false
    }
  }

  private lost(cl: RedisClient, e?: unknown): void {
    if (this.client !== cl) return
    this.client = null
    this.onDown?.()
    if (this.closing) return
    this.warn(e ?? new Error('connection lost'))
    this.schedule()
  }

  private schedule(): void {
    if (this.closing || this.timer) return
    const { reconnectMinMs, reconnectMaxMs } = this.o
    const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(this.fails++, 20))
    const delay = base * (0.8 + Math.random() * 0.4)
    this.timer = setTimeout(async () => {
      this.timer = null
      if (this.closing) return
      this.reconnects++
      if (!(await this.attempt())) this.schedule()
    }, delay)
  }

  /** The first failure, then every 10th; host:port only, the password scrubbed from the message. */
  private warn(e: unknown): void {
    if (this.warned++ % 10 !== 0) return
    console.warn(`[brust] cache-redis ${this.what}: ${redact(this.o.url)} unavailable (${this.scrub(e)}); retrying`)
  }

  private scrub(e: unknown): string {
    let m = e instanceof Error ? e.message : String(e)
    try {
      const u = new URL(this.o.url)
      for (const s of [this.o.url, u.password, u.username]) if (s) m = m.split(s).join('<redacted>')
    } catch {}
    return m.slice(0, 200)
  }
}
