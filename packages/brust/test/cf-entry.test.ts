import { expect, test } from 'bun:test'
import { type CfConfigJson, type CfEntryInput, cfEntrySource } from '../src/build/cf-entry'

const config: CfConfigJson = { abi: 1, generator: 'brust/2.0.0-alpha.2', l1Capacity: 256, jobCacheCapacity: 512, stats: false, edgeCache: 'off' }
const base: CfEntryInput = {
  entry: '/app/routes.tsx',
  jobsEntry: '/app/dist/cf/.stage/jobs.ts',
  actionsEntry: '/app/actions.ts',
  prefix: '/_brust/action',
  manifestPath: '/app/dist/manifest.json',
  templatesPath: '/app/dist/cf/.stage/templates.json',
  config: { ...config, actions: { prefix: '/_brust/action', maxBodyBytes: 1048576, maxResponseBytes: 8388608, crossSite: 'reject' } },
}

test('actions + stores', () => expect(cfEntrySource(base)).toMatchSnapshot())
test('no actions', () => expect(cfEntrySource({ ...base, actionsEntry: null, config })).toMatchSnapshot())
test('prefix /api', () => expect(cfEntrySource({ ...base, prefix: '/api' })).toMatchSnapshot())

test('no-actions entry carries no elysia / actions import and stubs the action', () => {
  const s = cfEntrySource({ ...base, actionsEntry: null, config })
  expect(s).toContain('export const action = noActions')
  expect(s).not.toContain('elysia')
  expect(s).not.toContain('server-handlers/actions')
  expect(s).not.toContain('mountActions')
})

test('CONFIG round-trips JSON.parse and the entry stays within 25 lines', () => {
  const s = cfEntrySource(base)
  const line = s.split('\n').find((l) => l.startsWith('export const CONFIG = '))!
  expect(JSON.parse(JSON.parse(line.slice('export const CONFIG = '.length)))).toEqual(base.config)
  expect(s.trimEnd().split('\n').length).toBeLessThanOrEqual(25)
})

test('hostile paths are quoted, not interpolated', () => {
  const s = cfEntrySource({ ...base, entry: '/a"b\n/c.tsx' })
  expect(s).toContain('import * as R from "/a\\"b\\n/c.tsx"')
})

test('cache adapter: the install wrapper replaces the re-export; without cache the entry is unchanged', () => {
  const cache = { adapter: 'custom', getTimeoutMs: 100, maxBodyBytes: 1048576, namespace: 'n', buildId: '0123456789abcdef', epochIntervalMs: 1000 }
  const plain = cfEntrySource({ ...base, cache: null })
  expect(plain).toBe(cfEntrySource(base))
  const s = cfEntrySource({ ...base, config: { ...base.config, cache }, cache: { module: '/app/lib/cache.ts', options: { k: 1 } } })
  expect(s).toContain('import CACHE from "/app/lib/cache.ts"')
  expect(s).toContain('import { waitUntil } from "cloudflare:workers"')
  expect(s).toContain('export const install = (rt) => installRuntime(rt, { adapter: CACHE, options: {"k":1}, config: {"adapter":"custom"')
  expect(s).not.toContain('export { install } from')
  expect(s).not.toContain('CACHE_BROADCAST')
  const composed = cfEntrySource({ ...base, config: { ...base.config, cache }, cache: { module: '@brust/cache-cloudflare/kv', options: {}, broadcast: '@brust/cache-cloudflare/do', broadcastOptions: { b: 2 } } })
  expect(composed).toContain('import CACHE_BROADCAST from "@brust/cache-cloudflare/do"')
  expect(composed).toContain('broadcast: CACHE_BROADCAST, broadcastOptions: {"b":2}')
})

test('doClass adds exactly one BrustCacheDO re-export; without it the entry is unchanged (D3)', () => {
  const cache = { adapter: 'cloudflare-do', getTimeoutMs: 100, maxBodyBytes: 1048576, namespace: 'n', buildId: '0123456789abcdef', epochIntervalMs: 1000 }
  const input = { ...base, config: { ...base.config, cache }, cache: { module: '@brust/cache-cloudflare/do', options: {} } }
  const without = cfEntrySource(input)
  const withDo = cfEntrySource({ ...input, doClass: true })
  expect(without).not.toContain('BrustCacheDO')
  expect(withDo.match(/export \{ BrustCacheDO \} from "@brust\/cache-cloudflare\/do"/g)).toHaveLength(1)
  expect(withDo.replace('export { BrustCacheDO } from "@brust/cache-cloudflare/do"\n', '')).toBe(without)
  expect(cfEntrySource({ ...base, doClass: false })).toBe(cfEntrySource(base))
})

// F475: the Worker's CONFIG carries the stream list and its ceiling, and nothing the platform owns.
test('cfActions: no list = the old block; a list sends the routes and the ceiling, not the timeouts', async () => {
  const { cfActions } = await import('../src/build/cloudflare')
  const a = { prefix: '/api', maxBodyBytes: 1024 }
  expect(cfActions(a)).toEqual({ prefix: '/api', maxBodyBytes: 1024, maxResponseBytes: 8388608, crossSite: 'reject' })
  expect(cfActions({ ...a, stream: [] })).toEqual(cfActions(a))
  const s = cfActions({ ...a, stream: ['POST /upload'], maxStreamBytes: 4096, streamIdleMs: 1, streamTotalMs: 2, maxStreams: 3 } as typeof a)
  expect(s).toEqual({ prefix: '/api', maxBodyBytes: 1024, maxResponseBytes: 8388608, crossSite: 'reject', stream: ['POST /upload'], maxStreamBytes: 4096 })
})
