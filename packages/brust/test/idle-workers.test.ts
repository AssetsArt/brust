// F165 (R40.1): which builds need a worker pool, and the pool `run` spawns for a manifest.
import { expect, test } from 'bun:test'
import { type ManifestJson, needsWorkers, reachedJobs } from '../src/build/manifest'
import type { BrustConfig } from '../src/config'
import { startOptions, workerCount } from '../src/run'

type M = Pick<ManifestJson, 'routes' | 'components' | 'actions' | 'cache'>
const route = (loaders: string[] = []) => ({ id: 'r', pattern: '/', chain: ['c'], loaders, cache: null, catch_all: false })
const comp = (jobs: unknown[] = [], children: string[] = []) => ({ tier: 'static', template: 'jinja/c.jinja', jobs, children: children.map((id) => ({ id, instances: 'static', props: {} })), client: null, needs_worker: jobs.length > 0, use_id_slots: 0, stores: [], features: [] })
const staticApp = (): M => ({ routes: [route()], components: { c: comp() } as unknown as M['components'], actions: null })

test('a build with no loader, job, actions app or cache adapter needs no worker', () => {
  expect(needsWorkers(staticApp())).toBe(false)
})

test('any one source of worker calls needs the pool', () => {
  expect(needsWorkers({ ...staticApp(), routes: [route(), route(['r'])] })).toBe(true)
  // a job of a chain component or of one of its children[] records, precompute or SSR
  for (const kind of ['precompute', 'ssr']) {
    expect(needsWorkers({ ...staticApp(), components: { c: comp([{ id: 'j', kind }]) } as unknown as M['components'] })).toBe(true)
    expect(needsWorkers({ ...staticApp(), components: { c: comp([], ['kid']), kid: comp([{ id: 'j', kind }]) } as unknown as M['components'] })).toBe(true)
  }
  expect(needsWorkers({ ...staticApp(), actions: { entry: 'actions.js', prefix: '/_brust/action', maxBodyBytes: 1 } as M['actions'] })).toBe(true)
  expect(needsWorkers({ ...staticApp(), cache: { adapter: 'memory' } as M['cache'] })).toBe(true)
})

test('F461: a route that reads a store needs the pool even with no loader or job (brust-core asks the worker for the snapshot)', () => {
  const stored = (stores: string[], jobs: unknown[] = [], children: string[] = []) => ({ ...comp(jobs, children), stores })
  const withStores = (components: unknown): M => ({ ...staticApp(), components } as unknown as M)
  expect(needsWorkers(withStores({ c: stored(['@brust/core/navigation']) }))).toBe(true)
  // through a child, and through the target of a job
  expect(needsWorkers(withStores({ c: stored([], [], ['kid']), kid: stored(['s.ts']) }))).toBe(true)
  expect(needsWorkers(withStores({ c: stored([], [{ id: 'j', kind: 'ssr', target: 'isl' }]), isl: stored(['s.ts']) }))).toBe(true)
  // a store only a component no route renders reads does not count
  expect(needsWorkers(withStores({ c: stored([]), other: stored(['s.ts']) }))).toBe(false)
})

test('F183: a job no route plans needs no worker (a child of a child, or a component no route renders)', () => {
  const components = { c: comp([], ['kid']), kid: comp([], ['grandkid']), grandkid: comp([{ id: 'j', kind: 'precompute' }]), other: comp([{ id: 'j', kind: 'ssr', target: 'other' }]) }
  expect(needsWorkers({ ...staticApp(), components } as unknown as M)).toBe(false)
})

test('F183: reachedJobs plans the chain and its direct children; ssr goes to the targets of their jobs', () => {
  const components = {
    c: comp([{ id: 'j0', kind: 'ssr', target: 'island' }], ['kid']),
    kid: comp([{ id: 'j0', kind: 'precompute' }, { id: 'j1', kind: 'ssr', target: 'kidIsland' }], ['grandkid']),
    grandkid: comp([{ id: 'j0', kind: 'ssr', target: 'deep' }]),
    island: comp(),
    kidIsland: comp(),
    deep: comp(),
    page: comp([{ id: 'j0', kind: 'ssr', target: 'page' }]),
    unrouted: comp([{ id: 'j0', kind: 'ssr', target: 'unroutedIsland' }]),
  }
  const r = reachedJobs({ routes: [route(), { ...route(), id: 'p', chain: ['page'] }], components } as unknown as M)
  expect([...r.planned].sort()).toEqual(['c', 'kid', 'page'])
  expect([...r.ssr].sort()).toEqual(['island', 'kidIsland', 'page'])
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
