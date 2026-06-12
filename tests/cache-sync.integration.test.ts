// R9 cache-sync integration: real redis at 127.0.0.1:6379, real NAPI addon.
// Skips cleanly (test.skipIf) when no local redis answers PING within 1s —
// CI has no redis service, so there these tests exercise the skip path; the
// connected path runs on dev machines. The module itself must load without
// redis (the probe swallows every failure).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { cache } from '../runtime/cache.ts'
import { startCacheSync, stopCacheSync } from '../runtime/cache-sync.ts'
import * as native from '../runtime/index.js'

const REDIS_URL = 'redis://127.0.0.1:6379'

// skipIf evaluates at collection time → the probe must complete BEFORE it:
// top-level await on a short-timeout PING.
const redisAvailable = await (async () => {
  try {
    const c = new RedisClient(REDIS_URL)
    await Promise.race([
      c.send('PING', []),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 1000)),
    ])
    c.close()
    return true
  } catch {
    return false
  }
})()

// Unique channel per run so parallel/stale test runs (or a dev server on the
// same redis) never cross-talk with us on the default channel.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// These tests mutate BRUST_CACHE_SYNC_* env; other suites share the process —
// snapshot/restore around every test.
const ENV_KEYS = ['BRUST_CACHE_SYNC_URL', 'BRUST_CACHE_SYNC_CHANNEL', 'BRUST_CACHE_SYNC_SENDER']
const SAVED: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  stopCacheSync()
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

async function until(cond: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await Bun.sleep(stepMs)
  }
  return cond()
}

test.skipIf(!redisAvailable)(
  'subscriber applies a remote invalidation message to the local NAPI caches',
  async () => {
    const channel = `brust:cache:invalidate:test:sub:${RUN_ID}`
    const external = new RedisClient(REDIS_URL)
    try {
      // Our own process token — the incoming message carries a DIFFERENT
      // sender, so the self-skip must not drop it.
      process.env.BRUST_CACHE_SYNC_SENDER = 'it-self-token'
      startCacheSync({ url: REDIS_URL, channel })
      // Give the subscribe a moment to land before seeding/publishing.
      await Bun.sleep(300)

      ;(native as any).islandCacheSet('it-sub-entry', ['it-tag'], undefined, '<p>x</p>', '{}')
      expect((native as any).islandCacheGet('it-sub-entry')).not.toBeNull()

      const payload = JSON.stringify({ v: 1, sender: 'it-other', tags: ['it-tag'] })
      // Re-publish while polling: redis pub/sub has no replay, so a publish
      // that races the subscribe registration would otherwise be lost and
      // flake the test. If the subscriber NEVER receives, this still fails.
      const evicted = await (async () => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          await external.publish(channel, payload)
          if (await until(() => (native as any).islandCacheGet('it-sub-entry') === null, 200))
            return true
        }
        return false
      })()
      expect(evicted).toBe(true)
    } finally {
      stopCacheSync()
      try {
        external.close()
      } catch {
        // best-effort
      }
    }
  },
)

test.skipIf(!redisAvailable)(
  'publisher emits a correctly-shaped message on cache.invalidate',
  async () => {
    const channel = `brust:cache:invalidate:test:pub:${RUN_ID}`
    const rawSubscriber = new RedisClient(REDIS_URL)
    try {
      const received: string[] = []
      await Promise.race([
        rawSubscriber.subscribe(channel, (message: string) => {
          received.push(message)
        }),
        new Promise((_, rj) => setTimeout(() => rj(new Error('subscribe timeout')), 2000)),
      ])

      process.env.BRUST_CACHE_SYNC_URL = REDIS_URL
      process.env.BRUST_CACHE_SYNC_CHANNEL = channel
      process.env.BRUST_CACHE_SYNC_SENDER = 'it-pub-token'

      cache.invalidate({ tags: ['it-pub'] })

      expect(await until(() => received.length > 0, 5000)).toBe(true)
      const msg = JSON.parse(received[0]!)
      expect(msg).toEqual({ v: 1, sender: 'it-pub-token', tags: ['it-pub'] })
    } finally {
      stopCacheSync()
      try {
        rawSubscriber.close()
      } catch {
        // best-effort
      }
    }
  },
)
