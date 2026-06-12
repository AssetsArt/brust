// Exercises runtime/cache-sync.ts against the REAL Rust NAPI addon (no
// mock.module — a module mock of ./index.js leaks across the whole test
// worker and breaks unrelated suites, since Bun's mock.restore() does not
// undo mock.module). No redis needed either: the publish path goes through
// the injectable test transport and the apply path hits NAPI directly.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  __setTransportForTest,
  applyCacheSyncMessage,
  publishCacheSync,
  redactUrl,
} from './cache-sync.ts'
import * as native from './index.js'

// These tests mutate BRUST_CACHE_SYNC_* env vars; other suites run in the
// same process, so snapshot and restore them around every test.
const ENV_KEYS = ['BRUST_CACHE_SYNC_URL', 'BRUST_CACHE_SYNC_CHANNEL', 'BRUST_CACHE_SYNC_SENDER']
const SAVED: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
  ;(native as any).islandCacheClear()
  ;(native as any).pageCacheClear()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
  __setTransportForTest(null)
})

// --- applyCacheSyncMessage: NAPI fan-out (mirrors cache.invalidate shapes) ---

test('apply by tags evicts island + page cache entries carrying the tag', () => {
  ;(native as any).islandCacheSet('cs-test-1', ['cs-tag-a'], undefined, '<p>x</p>', '{}')
  ;(native as any).pageCacheSet('cs-page-1', ['cs-tag-a'], 60000, Buffer.from('X'))

  applyCacheSyncMessage({ v: 1, tags: ['cs-tag-a'] })

  expect((native as any).islandCacheGet('cs-test-1')).toBeNull()
  expect((native as any).pageCacheGet('cs-page-1')).toBeNull()
})

test('apply by key evicts exactly that entry', () => {
  ;(native as any).islandCacheSet('cs-test-2', [], undefined, '<p>x</p>', '{}')
  ;(native as any).islandCacheSet('cs-test-3', [], undefined, '<p>y</p>', '{}')

  applyCacheSyncMessage({ v: 1, key: 'cs-test-2' })

  expect((native as any).islandCacheGet('cs-test-2')).toBeNull()
  expect((native as any).islandCacheGet('cs-test-3')).not.toBeNull()
})

test('self-skip: message whose sender matches our own token is not applied', () => {
  process.env.BRUST_CACHE_SYNC_SENDER = 'tok'
  ;(native as any).islandCacheSet('cs-self', ['cs-self-tag'], undefined, '<p>x</p>', '{}')

  applyCacheSyncMessage({ v: 1, sender: 'tok', tags: ['cs-self-tag'] })
  expect((native as any).islandCacheGet('cs-self')).not.toBeNull()

  // A different sender DOES apply.
  applyCacheSyncMessage({ v: 1, sender: 'other', tags: ['cs-self-tag'] })
  expect((native as any).islandCacheGet('cs-self')).toBeNull()
})

test('wrong version is dropped without throwing', () => {
  ;(native as any).islandCacheSet('cs-v2', ['cs-v2-tag'], undefined, '<p>x</p>', '{}')
  expect(() => applyCacheSyncMessage({ v: 2, tags: ['cs-v2-tag'] } as any)).not.toThrow()
  expect((native as any).islandCacheGet('cs-v2')).not.toBeNull()
})

test('malformed fields are dropped without throwing', () => {
  ;(native as any).islandCacheSet('cs-bad', ['cs-bad-tag'], undefined, '<p>x</p>', '{}')

  expect(() => applyCacheSyncMessage({ v: 1, tags: 'not-array' } as any)).not.toThrow()
  expect(() => applyCacheSyncMessage({ v: 1, tags: [42] } as any)).not.toThrow()
  expect(() => applyCacheSyncMessage({ v: 1, key: 42 } as any)).not.toThrow()
  expect(() => applyCacheSyncMessage(null as any)).not.toThrow()

  expect((native as any).islandCacheGet('cs-bad')).not.toBeNull()
})

// --- publishCacheSync: emptiness guard, config gate, message shape ---

function spyTransport() {
  const calls: Array<{ channel: string; message: string }> = []
  __setTransportForTest({
    publish(channel: string, message: string) {
      calls.push({ channel, message })
      return Promise.resolve(1)
    },
  })
  return calls
}

test('publish: empty invalidations are not published', () => {
  process.env.BRUST_CACHE_SYNC_URL = 'redis://127.0.0.1:6379'
  const calls = spyTransport()

  publishCacheSync({})
  publishCacheSync({ tags: [] })

  expect(calls.length).toBe(0)
})

test('publish: no-op when BRUST_CACHE_SYNC_URL is absent', () => {
  const calls = spyTransport()
  publishCacheSync({ tags: ['a'] })
  expect(calls.length).toBe(0)
})

test('publish: emits a v1 message with sender on the default channel', () => {
  process.env.BRUST_CACHE_SYNC_URL = 'redis://127.0.0.1:6379'
  process.env.BRUST_CACHE_SYNC_SENDER = 'sender-tok'
  const calls = spyTransport()

  publishCacheSync({ tags: ['a'] })

  expect(calls.length).toBe(1)
  expect(calls[0]?.channel).toBe('brust:cache:invalidate')
  expect(JSON.parse(calls[0]?.message ?? '')).toEqual({
    v: 1,
    sender: 'sender-tok',
    tags: ['a'],
  })
})

test('publish: honors BRUST_CACHE_SYNC_CHANNEL and carries key/path/method', () => {
  process.env.BRUST_CACHE_SYNC_URL = 'redis://127.0.0.1:6379'
  process.env.BRUST_CACHE_SYNC_CHANNEL = 'custom:chan'
  const calls = spyTransport()

  publishCacheSync({ key: 'k', path: '/p', method: 'POST' })

  expect(calls.length).toBe(1)
  expect(calls[0]?.channel).toBe('custom:chan')
  expect(JSON.parse(calls[0]?.message ?? '')).toEqual({
    v: 1,
    key: 'k',
    path: '/p',
    method: 'POST',
  })
})

test('publish: a rejecting transport never throws into the caller', () => {
  process.env.BRUST_CACHE_SYNC_URL = 'redis://127.0.0.1:6379'
  __setTransportForTest({
    publish() {
      return Promise.reject(new Error('down'))
    },
  })
  expect(() => publishCacheSync({ tags: ['a'] })).not.toThrow()
})

// --- redactUrl: credentials never reach a log line ---

test('redactUrl prints host:port only, never credentials', () => {
  expect(redactUrl('redis://:s3cret@db.example.com:6380/2')).toBe('db.example.com:6380')
  expect(redactUrl('redis://user:pass@127.0.0.1:6379')).toBe('127.0.0.1:6379')
  expect(redactUrl('not a url at all ::')).toBe('<unparseable redis url>')
})
