import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setNative } from '../src/native'
import { defineRoutes, flattenRoutes, httpError, notFound, redirect } from '../src/routes'
import { jobIdOf, literalsIndex, makeDispatch, makeHandlers, SLOT_BYTES, startWorker, writeSlot } from '../src/worker'

const C = () => null
const ctx = (routeId: string) => ({
  routeId,
  params: { id: '7' },
  path: '/items/7',
  req: { method: 'GET', url: '/items/7', headers: {}, cookies: {}, search: {} },
})
// biome-ignore lint/suspicious/noExplicitAny: loader fixtures
const leaves = (o: { parent?: any; child?: any }) =>
  flattenRoutes(defineRoutes([{ Component: C, loader: o.parent, children: [{ path: '/items/{id}', Component: C, loader: o.child }] }]))
    .leaves

test('loader: chain runs top-down, flat merge, child keys win', async () => {
  const h = makeHandlers({
    leaves: leaves({ parent: async () => ({ a: 1, b: 'parent' }), child: async ({ params }: { params: { id: string } }) => ({ b: params.id }) }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ ok: true, data: { a: 1, b: '7' } })
})

test('loader: first verdict wins and stops the chain; httpError throw is a verdict', async () => {
  let childRan = false
  const h = makeHandlers({
    leaves: leaves({
      parent: async () => notFound({ why: 'x' }),
      child: async () => {
        childRan = true
        return {}
      },
    }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ verdict: 'notFound', data: { why: 'x' } })
  expect(childRan).toBe(false)
  const r = makeHandlers({ leaves: leaves({ child: async () => redirect('/login', 303) }), jobs: {} })
  expect(await r.loader(ctx('r1'))).toEqual({ verdict: 'redirect', location: '/login', status: 303 })
  const e = makeHandlers({ leaves: leaves({ child: async () => httpError(403, 'no') }), jobs: {} })
  expect(await e.loader(ctx('r1'))).toEqual({ verdict: 'httpError', status: 403, body: 'no' })
})

test('loader: a throw becomes {error}; unknown routeId too', async () => {
  const h = makeHandlers({
    leaves: leaves({
      child: async () => {
        throw new Error('boom')
      },
    }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ error: 'Error: boom' })
  expect(await h.loader(ctx('r9'))).toEqual({ error: 'unknown routeId r9' })
})

test('jobs: precompute by componentId, ssr by target, errors per job', async () => {
  const h = makeHandlers({
    leaves: [],
    jobs: {
      price_1: { precompute: (p) => ({ _s1: `${p.item.price}${p.unit}` }) },
      team_2: { ssr: (p) => `<ul>${p.team.join('')}</ul>` },
      bad_3: {
        precompute: () => {
          throw new Error('nope')
        },
      },
    },
  })
  const r = await h.jobs({
    jobs: [
      { id: 'page_0/price_1_1/j0/0', componentId: 'price_1', kind: 'precompute', inputs: { item: { price: 3 }, unit: 'x' } },
      { id: 'page_0/j1', componentId: 'page_0', kind: 'ssr', target: 'team_2', inputs: { team: ['a', 'b'] } },
      { id: 'bad_3/j0', componentId: 'bad_3', kind: 'precompute', inputs: {} },
      { id: 'zzz/j0', componentId: 'zzz', kind: 'precompute', inputs: {} },
    ],
  })
  expect(r).toEqual({
    results: [
      { id: 'page_0/price_1_1/j0/0', value: { _s1: '3x' } },
      { id: 'page_0/j1', value: '<ul>ab</ul>' },
      { id: 'bad_3/j0', error: 'Error: nope' },
      { id: 'zzz/j0', error: 'no precompute job for component zzz' },
    ],
  })
})

test('jobs: ssr merges the manifest job literals over the server-built inputs', async () => {
  const manifest = {
    components: {
      page_0: {
        jobs: [
          { id: 'j0', kind: 'precompute' },
          { id: 'j1', kind: 'ssr', target: 'list_2', props: { items: 'feed.items' }, literals: { limit: 3, title: 'Top' } },
        ],
      },
      host_5: { jobs: [{ id: 'j0', kind: 'ssr', target: 'list_2', literals: { limit: 9 } }] },
    },
  }
  const seen: unknown[] = []
  const h = makeHandlers({
    leaves: [],
    manifest,
    jobs: {
      list_2: {
        ssr: (p) => {
          seen.push(p)
          return `<ol data-limit="${p.limit}">${p.items.slice(0, p.limit).join('')}</ol>`
        },
      },
    },
  })
  const r = await h.jobs({
    jobs: [
      // chain job, per_instance row 1: id `<componentId>/<jobId>/<row>`
      { id: 'page_0/j1/1', componentId: 'page_0', kind: 'ssr', target: 'list_2', inputs: { items: ['a', 'b', 'c', 'd'] } },
      // inlined child instance: id `<parentId>/<childId>_<k>/<jobId>`
      { id: 'page_0/host_5_1/j0', componentId: 'host_5', kind: 'ssr', target: 'list_2', inputs: { items: ['x'] } },
    ],
  })
  expect(seen[0]).toEqual({ items: ['a', 'b', 'c', 'd'], limit: 3, title: 'Top' })
  expect(seen[1]).toEqual({ items: ['x'], limit: 9 })
  expect(r.results).toEqual([
    { id: 'page_0/j1/1', value: '<ol data-limit="3">abc</ol>' },
    { id: 'page_0/host_5_1/j0', value: '<ol data-limit="9">x</ol>' },
  ])
  expect(jobIdOf({ id: 'page_0/j1', componentId: 'page_0' })).toBe('j1')
  expect(jobIdOf({ id: 'page_0/host_5_2/j3/4', componentId: 'host_5' })).toBe('j3')
  expect(literalsIndex(manifest).get('page_0/j1')).toEqual({ limit: 3, title: 'Top' })
  expect(literalsIndex(manifest).has('page_0/j0')).toBe(false)
})

test('writeSlot stays inside the slot and substitutes an error when too large', () => {
  const view = new Uint8Array(new SharedArrayBuffer(128))
  view.fill(0x41)
  const n = writeSlot(view, 1, 2, '{"ok":true}')
  expect(new TextDecoder().decode(view.subarray(64, 64 + n))).toBe('{"ok":true}')
  expect(view[0]).toBe(0x41) // slot 0 untouched
  const big = writeSlot(view, 0, 2, JSON.stringify({ data: 'x'.repeat(100) }))
  expect(big).toBeLessThanOrEqual(64)
  expect(view[64]).toBe('{'.charCodeAt(0)) // slot 1 untouched
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, big)))).toEqual({ error: 'response too large: 111 > 64' })
})

test('dispatch never rejects', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(1024))
  const d = makeDispatch(makeHandlers({ leaves: [], jobs: {} }), view, 1)
  const n = await d('bogus', '{not json', 0)
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, n))).error).toMatch(/JSON/)
  const m = await d('bogus' as 'jobs', '{}', 0)
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, m)))).toEqual({ error: 'unknown call kind bogus' })
  const throwing = { loader: () => Promise.reject(new Error('x')), jobs: () => Promise.reject(new Error('y')) }
  // biome-ignore lint/suspicious/noExplicitAny: a deliberately broken handler pair
  const k = await makeDispatch(throwing as any, view, 1)('jobs', '{"jobs":[]}', 0)
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, k)))).toEqual({ error: 'Error: y' })
})

test('worker.ts auto-starts inside a Bun Worker when BRUST_WORKER_ID is set', async () => {
  // No BRUST_APP_ENTRY: startWorker() throws its own message, which proves the guard fired.
  const w = new Worker(new URL('../src/worker.ts', import.meta.url), {
    env: { ...process.env, BRUST_WORKER_ID: '0', BRUST_APP_ENTRY: '' },
  })
  const msg = await new Promise<string>((res) => {
    w.addEventListener('error', (e) => res((e as ErrorEvent).message))
    setTimeout(() => res('no error: worker.ts did not auto-start'), 3000)
  })
  w.terminate()
  expect(msg).toContain('BRUST_APP_ENTRY is not set')
})

test('loader: notFound under a layout keeps the parent data (verdict data wins on conflicts)', async () => {
  const h = makeHandlers({
    leaves: leaves({ parent: async () => ({ user: 'ann', title: 'parent' }), child: async () => notFound({ title: 'gone', why: 'x' }) }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ verdict: 'notFound', data: { user: 'ann', title: 'gone', why: 'x' } })
  const bare = makeHandlers({ leaves: leaves({ parent: async () => ({ user: 'ann' }), child: async () => notFound() }), jobs: {} })
  expect(await bare.loader(ctx('r1'))).toEqual({ verdict: 'notFound', data: { user: 'ann' } })
})

// A minimal built app on disk for startWorker: empty manifest + jobs module, no routes.
function tinyApp(): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-worker-'))
  writeFileSync(join(d, 'manifest.json'), '{"components":{}}')
  writeFileSync(join(d, 'jobs.js'), 'export default {}\n')
  writeFileSync(join(d, 'routes.js'), 'export const routes = []\n')
  return d
}

test('startWorker registers the SharedArrayBuffer it is given (main-thread owned), else allocates one', async () => {
  const d = tinyApp()
  const keys = ['BRUST_DIST_DIR', 'BRUST_APP_ENTRY', 'BRUST_RENDER_SLOTS'] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const seen: { buf: Uint8Array; slots: number }[] = []
  // biome-ignore lint/suspicious/noExplicitAny: only registerWorker is exercised
  const fake: any = { registerWorker: (buf: Uint8Array, slots: number) => seen.push({ buf, slots }) - 1 }
  const prev = setNative(fake)
  try {
    Object.assign(process.env, { BRUST_DIST_DIR: d, BRUST_APP_ENTRY: join(d, 'routes.js'), BRUST_RENDER_SLOTS: '2' })
    const sab = new SharedArrayBuffer(SLOT_BYTES * 2)
    expect(await startWorker({ sab })).toBe(0)
    expect(seen[0]!.buf.buffer).toBe(sab) // the very buffer run.ts allocated, not a copy
    expect(seen[0]!.buf.byteLength).toBe(SLOT_BYTES * 2)
    expect(seen[0]!.slots).toBe(2)
    expect(await startWorker()).toBe(1) // tests / no workerData: allocate locally
    expect(seen[1]!.buf.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(seen[1]!.buf.buffer).not.toBe(sab)
    expect(seen[1]!.buf.byteLength).toBe(SLOT_BYTES * 2)
  } finally {
    setNative(prev)
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
    rmSync(d, { recursive: true, force: true })
  }
})

test('writeSlot: multi-byte overflow reports UTF-8 bytes, exact fit succeeds, tiny slot truncates like before', () => {
  const view = new Uint8Array(new SharedArrayBuffer(128))
  view.fill(0x41)
  // 'é' is 2 bytes: 40 chars = 80 bytes > 64 → the exact BYTE count is reported, slot 1 untouched.
  const n = writeSlot(view, 0, 2, JSON.stringify({ s: 'é'.repeat(40) }))
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, n)))).toEqual({ error: `response too large: ${Buffer.byteLength(JSON.stringify({ s: 'é'.repeat(40) }))} > 64` })
  expect(view[64]).toBe(0x41)
  // Exactly sub bytes fit (64 = {"s":" + 56 + "}).
  const fit = JSON.stringify({ s: 'x'.repeat(56) })
  expect(Buffer.byteLength(fit)).toBe(64)
  expect(writeSlot(view, 1, 2, fit)).toBe(64)
  expect(new TextDecoder().decode(view.subarray(64, 128))).toBe(fit)
  // A slot too small even for the error message: the first `sub` bytes of {"error":"too large"}, as before.
  const tiny = new Uint8Array(new SharedArrayBuffer(16))
  const t = writeSlot(tiny, 0, 1, JSON.stringify({ s: 'x'.repeat(100) }))
  expect(t).toBe(16)
  expect(new TextDecoder().decode(tiny.subarray(0, t))).toBe('{"error":"too la')
})

test('writeSlot encodes into a SharedArrayBuffer view with one copy (no detached intermediate)', () => {
  // encodeInto accepts [AllowShared] Uint8Array: the production view IS over a SAB (run.ts allocates it).
  const sab = new SharedArrayBuffer(SLOT_BYTES)
  const view = new Uint8Array(sab)
  const json = JSON.stringify({ ok: true, data: { name: 'ピカチュウ', n: [1, 2, 3] } })
  const n = writeSlot(view, 0, 1, json)
  expect(n).toBe(Buffer.byteLength(json))
  expect(new TextDecoder().decode(new Uint8Array(sab, 0, n))).toBe(json)
})

test('loader: the merge never mutates an object a loader returned (shared module constants stay intact)', async () => {
  const shared = Object.freeze({ a: 1, b: 'parent' })
  const h = makeHandlers({
    leaves: leaves({ parent: async () => shared, child: async () => ({ b: 'child', c: 3 }) }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ ok: true, data: { a: 1, b: 'child', c: 3 } })
  expect(shared).toEqual({ a: 1, b: 'parent' })
  // Key order is first-seen: a's keys, then new keys — what {...a, ...b} produced.
  expect(Object.keys((await h.loader(ctx('r1')) as { data: object }).data)).toEqual(['a', 'b', 'c'])
})
