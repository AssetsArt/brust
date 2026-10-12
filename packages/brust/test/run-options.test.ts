import { expect, test } from 'bun:test'
import type { BrustConfig } from '../src/config'
import { startOptions } from '../src/run'

const base = { host: '127.0.0.1', port: 3000, workers: 2, callTimeoutMs: 5000, ioThreads: 4 } as unknown as BrustConfig

test('no actions and no cors → exactly today\'s keys', () => {
  const o = startOptions(base, '/d', {}, '1.2.3')
  expect(Object.keys(o)).toEqual(['host', 'port', 'distDir', 'workers', 'callTimeoutMs', 'workerThreads', 'generator'])
  expect(o.generator).toBe('brust/1.2.3')
})

test('actions → { prefix, maxBodyBytes, maxResponseBytes } (camelCase, no entry)', () => {
  const o = startOptions(base, '/d', { actions: { entry: 'actions.js', prefix: '/_brust/action', maxBodyBytes: 262144, maxResponseBytes: 8388608 } }, 'v')
  expect(o.actions).toEqual({ prefix: '/_brust/action', maxBodyBytes: 262144, maxResponseBytes: 8388608 })
  expect(Object.keys(o.actions as object)).toEqual(['prefix', 'maxBodyBytes', 'maxResponseBytes'])
})

test('actions.crossSite is forwarded when the manifest carries it (F87)', () => {
  const o = startOptions(base, '/d', { actions: { entry: 'actions.js', prefix: '/api', maxBodyBytes: 1, crossSite: 'allow' } }, 'v')
  expect(o.actions).toEqual({ prefix: '/api', maxBodyBytes: 1, crossSite: 'allow' })
})

test('cors → passed through with camelCase keys only', () => {
  const cors = { origins: ['https://a.example'], methods: ['GET'], exposeHeaders: ['x-a'], credentials: true, maxAgeSeconds: 60 }
  const o = startOptions({ ...base, cors } as BrustConfig, '/d', {}, 'v')
  expect(o.cors).toEqual(cors)
  expect(JSON.stringify(o.cors)).not.toContain('_')
})

test('manifest.actions null → no actions key', () => {
  const o = startOptions(base, '/d', { actions: null }, 'v')
  expect('actions' in o).toBe(false)
})

test('manifest.cache → l2 { adapter, getTimeoutMs, maxBodyBytes, namespace, buildId } (camelCase)', () => {
  const cache = { adapter: 'custom', module: 'cache-adapter.js', options: { a: 1 }, getTimeoutMs: 50, maxBodyBytes: 1048576, namespace: 'n', buildId: '0123456789abcdef', epochIntervalMs: 1000 }
  const o = startOptions(base, '/d', { cache }, 'v')
  expect(o.l2).toEqual({ adapter: 'custom', getTimeoutMs: 50, maxBodyBytes: 1048576, namespace: 'n', buildId: '0123456789abcdef' })
  expect('l2' in startOptions(base, '/d', { cache: null }, 'v')).toBe(false)
})
