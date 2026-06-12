// R9 cross-process cache invalidation. Publishes cache.invalidate() calls to a
// redis/dragonfly pub/sub channel and applies messages from peers to the local
// process-global Rust caches. Pure TS — Bun's native RedisClient, zero deps.
//
// Bun 1.4.0 RedisClient facts (verified empirically — do not "simplify"):
// - subscribe(channel, cb): cb receives (message, channel). Errors do NOT come
//   through the callback; disconnects fire client.onclose.
// - Against an unreachable host, connect()/subscribe() return promises that
//   NEVER settle and onclose never fires → every connect must be raced
//   against a timeout or a down redis silently disables the feature.
// - No auto-resubscribe after a drop → onclose re-creates the client.
import { RedisClient } from 'bun'
import type { InvalidateArgs } from './cache.ts'
import * as native from './index.js'

/** Public wire contract (documented for external publishers like studio):
 * `{ "v": 1, "sender": "<uuid>", "key": "...", "tags": ["..."],
 *    "path": "...", "method": "GET" }` — all invalidation fields optional,
 * `sender` may be omitted (never matches our token, always applied). */
export interface CacheSyncMessage {
  v: 1
  sender?: string
  key?: string
  tags?: string[]
  path?: string
  method?: string
}

export const CHANNEL_DEFAULT = 'brust:cache:invalidate'
const CONNECT_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const WARN_THROTTLE_MS = 30_000

// Per-isolate state. The subscriber lives in the main isolate only (run()
// wires it); the publisher is lazy per isolate (workers publish from
// loaders/actions). Rust caches are process-global, so applying here reaches
// every worker implicitly.
let started = false
let stopped = false
let subscriber: RedisClient | null = null
let publisher: RedisClient | null = null
let publisherUrl: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = BACKOFF_BASE_MS
const lastWarnAt = new Map<string, number>()

/** Injectable publish seam so unit tests never construct a RedisClient. */
export interface CacheSyncTransport {
  publish(channel: string, message: string): Promise<unknown>
}
let testTransport: CacheSyncTransport | null = null
export function __setTransportForTest(t: CacheSyncTransport | null): void {
  testTransport = t
}

/** The redis URL may carry credentials (`redis://:pass@host:port/db`). Every
 * log line that mentions the target MUST go through this — host:port only. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '6379'}`
  } catch {
    return '<unparseable redis url>'
  }
}

/** Error messages from RedisClient may embed the raw connection string —
 * scrub the configured URL (and any redis://user:pass@ userinfo) before a
 * message reaches the log. */
function scrubErrorMessage(e: unknown, url: string): string {
  const raw = String((e as Error)?.message ?? e)
  return raw
    .replaceAll(url, redactUrl(url))
    .replace(/rediss?:\/\/[^@\s]+@/gi, 'redis://<redacted>@')
}

/** Once per 30s per error kind — a down redis must not spam the log on every
 * invalidate/retry. */
function warnThrottled(kind: string, msg: string): void {
  const now = Date.now()
  const last = lastWarnAt.get(kind) ?? 0
  if (now - last < WARN_THROTTLE_MS) return
  lastWarnAt.set(kind, now)
  console.warn(`[brust] ${msg}`)
}

/** Apply a parsed peer message to the local NAPI caches. Direct fan-out —
 * NEVER via cache.invalidate, so a received message can never re-publish
 * (no loop, even across misconfigured channels). Exported for tests. */
export function applyCacheSyncMessage(msg: CacheSyncMessage): void {
  if (msg === null || typeof msg !== 'object' || msg.v !== 1) {
    warnThrottled('apply', 'cache-sync: dropping message with unsupported shape/version')
    return
  }
  if (
    msg.tags !== undefined &&
    (!Array.isArray(msg.tags) || msg.tags.some((t) => typeof t !== 'string'))
  ) {
    warnThrottled('apply', 'cache-sync: dropping message — tags must be an array of strings')
    return
  }
  for (const field of ['sender', 'key', 'path', 'method'] as const) {
    if (msg[field] !== undefined && typeof msg[field] !== 'string') {
      warnThrottled('apply', `cache-sync: dropping message — ${field} must be a string`)
      return
    }
  }
  // The publishing isolate already applied locally — skip our own messages.
  if (msg.sender && msg.sender === process.env.BRUST_CACHE_SYNC_SENDER) {
    return
  }
  // EXACT mirror of cache.invalidate's local NAPI fan-out (cache.ts). `?.`
  // keeps a stale addon (built before a binding existed) a no-op.
  ;(native as any).islandCacheInvalidate?.(msg.key, msg.tags)
  ;(native as any).pageCacheInvalidate?.(msg.key, msg.tags)
  ;(native as any).responseCacheInvalidate?.(msg.tags, msg.path, msg.method)
}

/** Publish an invalidation to peers. No-op when sync is not configured
 * (BRUST_CACHE_SYNC_URL absent). Fire-and-forget: synchronous from the
 * caller's view, failures warn (throttled) and never propagate — local
 * invalidation must never depend on redis state. */
export function publishCacheSync(args: InvalidateArgs): void {
  // invalidate({}) is a deliberate local no-op — don't broadcast it either.
  if (!args.key && (!args.tags || args.tags.length === 0) && !args.path) return
  const url = process.env.BRUST_CACHE_SYNC_URL
  if (!url) return
  const channel = process.env.BRUST_CACHE_SYNC_CHANNEL || CHANNEL_DEFAULT

  const msg: CacheSyncMessage = { v: 1 }
  const sender = process.env.BRUST_CACHE_SYNC_SENDER
  if (sender) msg.sender = sender
  if (args.key) msg.key = args.key
  if (args.tags && args.tags.length > 0) msg.tags = args.tags
  if (args.path) msg.path = args.path
  if (args.method) msg.method = args.method

  try {
    const transport = testTransport ?? getPublisher(url)
    transport.publish(channel, JSON.stringify(msg)).catch((e) => {
      // Heal the lazy client: a publisher that died (redis restart) would
      // otherwise be returned forever by getPublisher — drop it so the next
      // publish reconnects.
      if (transport === publisher) {
        try {
          publisher?.close()
        } catch {
          // best-effort
        }
        publisher = null
        publisherUrl = null
      }
      warnThrottled(
        'publish',
        `cache-sync: publish to ${redactUrl(url)} failed: ${scrubErrorMessage(e, url)}`,
      )
    })
  } catch (e) {
    warnThrottled(
      'publish',
      `cache-sync: publish to ${redactUrl(url)} failed: ${scrubErrorMessage(e, url)}`,
    )
  }
}

function getPublisher(url: string): CacheSyncTransport {
  if (!publisher || publisherUrl !== url) {
    try {
      publisher?.close()
    } catch {
      // best-effort
    }
    publisher = new RedisClient(url)
    publisherUrl = url
  }
  return publisher
}

/** Start the subscriber (main isolate only — run() guards; workers never call
 * this). Idempotent; never throws. A down redis at boot logs a redacted warn
 * and retries with capped exponential backoff — the server boots regardless. */
export function startCacheSync(opts: { url: string; channel?: string }): void {
  if (started) return
  started = true
  stopped = false
  backoffMs = BACKOFF_BASE_MS
  const channel = opts.channel || process.env.BRUST_CACHE_SYNC_CHANNEL || CHANNEL_DEFAULT
  void attempt(opts.url, channel)
}

async function attempt(url: string, channel: string): Promise<void> {
  if (stopped) return
  const client = new RedisClient(url)
  subscriber = client
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // Race the subscribe against a timeout: against a down host the promise
    // NEVER settles (see header) — without the race a down redis at boot
    // would silently disable the feature forever. The no-op catch keeps a
    // late loser settling AFTER the timeout from becoming an unhandled
    // rejection.
    const subscribed = client.subscribe(channel, onMessage)
    subscribed.catch(() => {})
    await Promise.race([
      subscribed,
      new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
        timeoutTimer.unref?.()
      }),
    ])
    // Identity guard: a slow connect can settle AFTER the timeout already
    // scheduled a retry and a newer attempt replaced `subscriber` — this
    // stale winner must stand down, not double-subscribe.
    if (stopped || subscriber !== client) {
      try {
        client.close()
      } catch {
        // best-effort
      }
      return
    }
    backoffMs = BACKOFF_BASE_MS
    // No auto-resubscribe after a drop (see header) — re-create the client.
    client.onclose = () => {
      if (!stopped && subscriber === client) scheduleRetry(url, channel)
    }
  } catch (e) {
    try {
      client.close()
    } catch {
      // best-effort
    }
    warnThrottled(
      'connect',
      `cache-sync: redis unreachable at ${redactUrl(url)}, retrying (${scrubErrorMessage(e, url)})`,
    )
    if (subscriber === client) scheduleRetry(url, channel)
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
  }
}

function scheduleRetry(url: string, channel: string): void {
  if (stopped || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void attempt(url, channel)
  }, backoffMs)
  // A dead redis must never hold the process open past drain.
  retryTimer.unref?.()
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
}

function onMessage(message: string, _channel: string): void {
  let parsed: CacheSyncMessage
  try {
    parsed = JSON.parse(message)
  } catch {
    warnThrottled('parse', 'cache-sync: dropping unparseable message')
    return
  }
  applyCacheSyncMessage(parsed)
}

/** Shutdown/test hook: stop retries, close both clients, reset state so tests
 * can restart. Wired into gracefulExit so backoff timers can't fire between
 * drain and exit. */
export function stopCacheSync(): void {
  stopped = true
  started = false
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  try {
    subscriber?.close()
  } catch {
    // best-effort
  }
  subscriber = null
  try {
    publisher?.close()
  } catch {
    // best-effort
  }
  publisher = null
  publisherUrl = null
  backoffMs = BACKOFF_BASE_MS
  lastWarnAt.clear()
}
