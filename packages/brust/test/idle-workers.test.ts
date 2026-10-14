// F165 (R40.1): which builds need a worker pool, and the pool `run` spawns for a manifest.
import { expect, test } from 'bun:test'
import { type ManifestJson, needsWorkers } from '../src/build/manifest'
import type { BrustConfig } from '../src/config'
import { startOptions, workerCount } from '../src/run'

type M = Pick<ManifestJson, 'routes' | 'components' | 'actions' | 'cache'>
const route = (loaders: string[] = []) => ({ id: 'r', pattern: '/', chain: ['c'], loaders, cache: null, catch_all: false })
const comp = (jobs: unknown[] = []) => ({ tier: 'static', template: 'jinja/c.jinja', jobs, children: [], client: null, needs_worker: jobs.length > 0, use_id_slots: 0, stores: [], features: [] })
const staticApp = (): M => ({ routes: [route()], components: { c: comp() } as unknown as M['components'], actions: null })

test('a build with no loader, job, actions app or cache adapter needs no worker', () => {
  expect(needsWorkers(staticApp())).toBe(false)
})

test('any one source of worker calls needs the pool', () => {
  expect(needsWorkers({ ...staticApp(), routes: [route(), route(['r'])] })).toBe(true)
  // a job of any component, reached by a route or not (F166), precompute or SSR
  for (const kind of ['precompute', 'ssr'])
    expect(needsWorkers({ ...staticApp(), components: { c: comp(), other: comp([{ id: 'j', kind }]) } as unknown as M['components'] })).toBe(true)
  expect(needsWorkers({ ...staticApp(), actions: { entry: 'actions.js', prefix: '/_brust/action', maxBodyBytes: 1 } as M['actions'] })).toBe(true)
  expect(needsWorkers({ ...staticApp(), cache: { adapter: 'memory' } as M['cache'] })).toBe(true)
})

const cfg = { host: '127.0.0.1', port: 3000, workers: 3, callTimeoutMs: 5000, ioThreads: 4 } as unknown as BrustConfig

test('only an explicit false spawns no worker: an absent bit (older or actions-only manifests) keeps the pool', () => {
  expect(workerCount(cfg, { needs_workers: false })).toBe(0)
  expect(workerCount(cfg, { needs_workers: true })).toBe(3)
  expect(workerCount(cfg, {})).toBe(3)
  expect(workerCount(cfg, { actions_only: true })).toBe(3)
  // the server waits for exactly the workers run spawns
  expect(startOptions(cfg, '/d', { needs_workers: false }, 'v').workers).toBe(0)
  expect(startOptions(cfg, '/d', {}, 'v').workers).toBe(3)
})
