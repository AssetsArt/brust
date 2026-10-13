import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { beginDrain, cacheInvalidate, cacheStats, localAddr, planJobs, registerWorker, startServer, untilReady } from '../native/index.js'
import { writeSlot } from '../src/worker'

const dist = resolve(import.meta.dir, '../../../crates/brust-server/tests/fixtures/dist')

type JobCall = { id: string; componentId: string; target?: string; inputs: any }
// The FakeBun default jobs (crates/brust-server/tests/common/mod.rs `default_job`).
function jobValue(call: JobCall) {
  const job = call.id.split('/').at(call.id.startsWith(`${call.componentId}/`) ? 1 : 2)
  if (call.componentId === 'detailPage_c3' && job === 'j0') return { _s1: 'HP 35' }
  if (call.componentId === 'moveCard_d4' && job === 'j0') return { _s1: `MOVE ${call.inputs.move.name}` }
  if ((call.target ?? call.componentId) === 'teamBuilder_h8') return '<ul><li>a</li></ul>'
  throw new Error(`unexpected job ${call.id}`)
}

const SLOTS = 2
const sab = new Uint8Array(new SharedArrayBuffer(256 * 1024 * SLOTS))
const kinds: string[] = []
const handler = async (kind: string, requestJson: string, slot: number) => {
  kinds.push(kind)
  const req = JSON.parse(requestJson)
  return writeSlot(
    sab,
    slot,
    SLOTS,
    JSON.stringify(
      kind === 'loader'
        ? { ok: true, data: { pokemon: { name: req.params.name ?? null, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
        : { results: req.jobs.map((j: JobCall) => ({ id: j.id, value: jobValue(j) })) },
    ),
  )
}

test('startServer + one worker answers pages, HIT skips Bun, invalidate forces MISS', async () => {
  expect(() => cacheStats()).toThrow(/startServer has not been called/)
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500, generator: 'brust/test' })
  await expect(untilReady(50)).rejects.toThrow(/workers failed to register within 50 ms/)
  expect(registerWorker(sab, SLOTS, handler)).toBeGreaterThanOrEqual(0)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

  const home = await fetch(`${base}/`)
  expect(home.status).toBe(200)
  expect(home.headers.get('x-powered-by')).toBe('brust/test')
  expect(await home.text()).toContain('<main><h1>Home</h1></main>')
  expect(JSON.parse(cacheStats()).loader_calls).toBe(0)

  const r1 = await fetch(`${base}/pokemon/pikachu`)
  expect(r1.status).toBe(200)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  const body = await r1.text()
  expect(body).toContain('<p>HP 35</p>')
  expect(body).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(kinds).toEqual(['loader', 'jobs']) // one batched jobs call per page

  const r2 = await fetch(`${base}/pokemon/pikachu`)
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  await r2.text()
  expect(JSON.parse(cacheStats()).loader_calls).toBe(1)

  // react-tier child: ssr job on the parent with `target` (D6).
  const team = await fetch(`${base}/team`)
  expect(team.status).toBe(200)
  expect(await team.text()).toContain('<ul><li>a</li></ul>')

  expect(cacheInvalidate({ tags: ['pokemon'] })).toEqual({ l1Removed: 1, jobRemoved: 0 })
  const r3 = await fetch(`${base}/pokemon/pikachu`)
  expect(r3.headers.get('x-brust-cache')).toBe('MISS')
  await r3.text()
  expect(cacheInvalidate({ path: '/pokemon/pikachu' })).toEqual({ l1Removed: 1, jobRemoved: 0 })

  await beginDrain(1000)
  expect(() => startServer({ host: '127.0.0.1', port: 0, distDir: '/nonexistent', workers: 0 })).toThrow(/manifest: .*manifest\.json/)
  // A failed start keeps the previous server as the current one.
  expect(JSON.parse(cacheStats()).loader_calls).toBe(3) // pikachu MISS ×2 + /team
})

test('a worker that takes the plan offer answers a loader page with misses in ONE call', async () => {
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500 })
  const view = new Uint8Array(new SharedArrayBuffer(256 * 1024 * SLOTS))
  const kinds2: string[] = []
  const planning = async (kind: string, requestJson: string, slot: number) => {
    kinds2.push(kind)
    const req = JSON.parse(requestJson)
    const ctx = { ok: true, data: { pokemon: { name: req.params.name, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
    const n = writeSlot(view, slot, SLOTS, JSON.stringify(ctx))
    expect(req.plan).toBe(true)
    const misses = planJobs(slot, n) // the real addon, on this (main) thread: registerWorker bound it
    if (misses === '!') return n
    const results = misses === '' ? [] : JSON.parse(misses).jobs.map((j: JobCall) => ({ id: j.id, value: jobValue(j) }))
    return writeSlot(view, slot, SLOTS, JSON.stringify({ planned: true, results }))
  }
  registerWorker(view, SLOTS, planning)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  const b1 = await (await fetch(`${base}/pokemon/pikachu`)).text()
  expect(b1).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(kinds2).toEqual(['loader'])
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 1, job_calls: 1, worker_calls: 1 })
  await (await fetch(`${base}/pokemon/bulbasaur`)).text() // L1 miss; every job hits → planJobs ""
  expect(kinds2).toEqual(['loader', 'loader'])
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 2, job_calls: 1, worker_calls: 2 })
  await beginDrain(1000)
})

// L10: the real addon, the real worker dispatch: loader / jobs / planned replies over the 256 KiB slot.
test('L10: a 300 KB loader ctx and a 300 KB job result cross the heap through the real addon (planJobsBuf + putFetchReply)', async () => {
  const { makeDispatch, makeHandlers } = await import('../src/worker')
  const { defineRoutes, flattenRoutes } = await import('../src/routes')
  const pad = 'p'.repeat(300_000)
  const leaves = flattenRoutes(
    defineRoutes([
      {
        Component: () => null,
        children: [
          {
            path: '/pokemon/{name}',
            Component: () => null,
            loader: async ({ params }: { params: { name: string } }) => ({ pokemon: { name: params.name, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon', pad }),
          },
        ],
      },
    ]),
  ).leaves
  // `leaves` route ids are the fixture's `r2`? The dispatch looks them up by routeId: re-key to the dist's ids.
  const keyed = leaves.map((l) => ({ ...l, id: 'r2' }))
  const jobs = {
    detailPage_c3: { precompute: () => ({ _s1: `HP 35 ${pad}` }) },
    moveCard_d4: { precompute: (p: { move: { name: string } }) => ({ _s1: `MOVE ${p.move.name}` }) },
  }
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 2000 })
  const view = new Uint8Array(new SharedArrayBuffer(256 * 1024))
  // biome-ignore lint/suspicious/noExplicitAny: handler fixtures
  registerWorker(view, 1, makeDispatch(makeHandlers({ leaves: keyed as any, jobs: jobs as any }), view, 1))
  await untilReady(2000)
  const body = await (await fetch(`http://${localAddr()}/pokemon/pikachu`)).text()
  expect(body).toContain(`HP 35 ${pad}`)
  expect(body).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 1, job_calls: 1, worker_calls: 1 })
  await beginDrain(1000)
})

// L10 delta (lead ruling): the HTTP-level over-cap case and a non-default slotBytes, through the real addon.
async function serveWithLoader(opts: { maxLoaderResponseBytes?: number; slotBytes: number; padBytes: number }) {
  const { makeDispatch, makeHandlers } = await import('../src/worker')
  const { defineRoutes, flattenRoutes } = await import('../src/routes')
  const pad = 'p'.repeat(opts.padBytes)
  const leaves = flattenRoutes(
    defineRoutes([
      {
        Component: () => null,
        children: [
          {
            path: '/pokemon/{name}',
            Component: () => null,
            loader: async ({ params }: { params: { name: string } }) => ({ pokemon: { name: params.name, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon', pad }),
          },
        ],
      },
    ]),
  ).leaves.map((l) => ({ ...l, id: 'r2' })) // the fixture dist's route id
  const jobs = {
    detailPage_c3: { precompute: () => ({ _s1: 'HP 35' }) },
    moveCard_d4: { precompute: (p: { move: { name: string } }) => ({ _s1: `MOVE ${p.move.name}` }) },
  }
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 2000, ...(opts.maxLoaderResponseBytes !== undefined ? { maxLoaderResponseBytes: opts.maxLoaderResponseBytes } : {}) })
  const view = new Uint8Array(new SharedArrayBuffer(opts.slotBytes))
  // biome-ignore lint/suspicious/noExplicitAny: handler fixtures
  // As `startWorker` configures it under `run()`: the worker's cap is the server's cap (BRUST_MAX_LOADER_RESPONSE_BYTES).
  const { planJobsBuf, putFetchReply } = await import('../src/native')
  const heap = { io: { takeBody: () => null, putReply: putFetchReply }, planBuf: planJobsBuf, cap: opts.maxLoaderResponseBytes ?? 8_388_608 }
  const dispatch = makeDispatch(makeHandlers({ leaves: leaves as any, jobs: jobs as any }), view, 1, undefined, heap)
  const replies: string[] = []
  registerWorker(view, 1, async (kind, json, slot) => {
    const n = await dispatch(kind, json, slot)
    replies.push(new TextDecoder().decode(view.subarray(0, Math.min(n, 200))))
    return n
  })
  await untilReady(2000)
  return { base: `http://${localAddr()}`, replies }
}

test('L10: a loader reply over maxLoaderResponseBytes answers 500 at the HTTP level, and the worker names the cap', async () => {
  const s = await serveWithLoader({ maxLoaderResponseBytes: 262_144, slotBytes: 256 * 1024, padBytes: 300_000 })
  const res = await fetch(`${s.base}/pokemon/pikachu`)
  expect(res.status).toBe(500)
  expect(s.replies.join('\n')).toMatch(/response too large: \d+ > 262144 \(maxLoaderResponseBytes\)/)
  await beginDrain(1000)
})

test('L10: slotBytes (BRUST_SLOT_BYTES) end to end: a 100 KiB loader reply over a 64 KiB slot still answers 200 through the heap', async () => {
  const { loadConfig } = await import('../src/config')
  const prev = process.env.BRUST_SLOT_BYTES
  process.env.BRUST_SLOT_BYTES = '65536'
  let slotBytes: number
  try {
    slotBytes = (await loadConfig(resolve(import.meta.dir, 'fixtures'))).slotBytes // the env layer, as `run()` reads it
  } finally {
    if (prev === undefined) delete process.env.BRUST_SLOT_BYTES
    else process.env.BRUST_SLOT_BYTES = prev
  }
  expect(slotBytes).toBe(65_536)
  const s = await serveWithLoader({ slotBytes, padBytes: 100 * 1024 })
  const res = await fetch(`${s.base}/pokemon/pikachu`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 1, job_calls: 1, worker_calls: 1 })
  await beginDrain(1000)
})
