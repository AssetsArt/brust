import { expect, spyOn, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setNative } from '../src/native'
import { defineRoutes, flattenRoutes, httpError, notFound, redirect } from '../src/routes'
import {
  type JobsModule,
  jobIdOf,
  literalsIndex,
  makeDispatch,
  makeHandlers,
  PLAN_DECLINED,
  type HeapReply,
  SLOT_BYTES,
  startWorker,
  writeSlot,
} from '../src/worker'

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

test('loader: an own "__proto__" key in loader data is kept as data, like the spread merge did', async () => {
  // JSON.parse makes "__proto__" an own data key. `{...a, ...r}` copied it as a key; a [[Set]]-based
  // merge (Object.assign into a plain object) would invoke the prototype setter and drop it.
  const h = makeHandlers({
    leaves: leaves({ parent: async () => JSON.parse('{"__proto__":{"x":1},"a":1}'), child: async () => ({ b: 2 }) }),
    jobs: {},
  })
  const r = (await h.loader(ctx('r1'))) as { data: Record<string, unknown> }
  expect(JSON.stringify(r)).toBe('{"ok":true,"data":{"__proto__":{"x":1},"a":1,"b":2}}')
  expect((r.data as { x?: unknown }).x).toBeUndefined()
})

// ---- M3-P P6: the plan offer ----

const dec = (v: Uint8Array, n: number) => JSON.parse(new TextDecoder().decode(v.subarray(0, n)))
const planned = (jobs: JobsModule) => makeHandlers({ leaves: leaves({ child: async () => ({ team: ['a'] }) }), jobs })

test('dispatch: a planned loader call hands the ctx to planJobs and answers the misses in the same call', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const seen: unknown[] = []
  const plan = (slot: number, len: number) => {
    seen.push(dec(view.subarray(slot * 4096), len)) // the ctx is in the slot when planJobs runs
    return JSON.stringify({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'precompute', inputs: { team: ['a'] } }] })
  }
  const d = makeDispatch(planned({ c: { precompute: (p: { team: string[] }) => ({ _s1: p.team.length }) } }), view, 1, plan)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(seen).toEqual([{ ok: true, data: { team: ['a'] } }])
  expect(dec(view, n)).toEqual({ planned: true, results: [{ id: 'c/j0', value: { _s1: 1 } }] })
})

test('dispatch: planJobs "" (every job hit) answers {planned:true}', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  let calls = 0
  const plan = () => {
    calls++
    return ''
  }
  const d = makeDispatch(planned({}), view, 1, plan)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(calls).toBe(1)
  expect(dec(view, n)).toEqual({ planned: true })
})

test('dispatch: planJobs "!" leaves the loader response in the slot', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const d = makeDispatch(planned({}), view, 1, () => PLAN_DECLINED)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(dec(view, n)).toEqual({ ok: true, data: { team: ['a'] } })
})

test('dispatch: verdicts, errors and plan:false never call planJobs', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const plan = (): string => {
    throw new Error('planJobs must not be called')
  }
  const nf = makeDispatch(makeHandlers({ leaves: leaves({ child: async () => notFound({ why: 'x' }) }), jobs: {} }), view, 1, plan)
  const a = await nf('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(dec(view, a)).toEqual({ verdict: 'notFound', data: { why: 'x' } })
  const boom = makeDispatch(
    makeHandlers({
      leaves: leaves({
        child: async () => {
          throw new Error('boom')
        },
      }),
      jobs: {},
    }),
    view,
    1,
    plan,
  )
  const b = await boom('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(dec(view, b)).toEqual({ error: 'Error: boom' })
  const c = await makeDispatch(planned({}), view, 1, plan)('loader', JSON.stringify(ctx('r1')), 0)
  expect(dec(view, c)).toEqual({ ok: true, data: { team: ['a'] } })
})

test('planJobs on a thread that registered no worker declines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brust-planjobs-'))
  try {
    const entry = join(dir, 'unbound.ts')
    const addon = join(import.meta.dir, '..', 'native', 'index.js')
    writeFileSync(
      entry,
      `import { parentPort } from 'node:worker_threads'\nconst { planJobs } = require(${JSON.stringify(addon)})\nparentPort.postMessage(planJobs(0, 10))\n`,
    )
    const w = new Worker(entry)
    const got = await new Promise<string>((res) => {
      w.addEventListener('message', (e) => res(String((e as MessageEvent).data)))
      w.addEventListener('error', (e) => res(`error: ${(e as ErrorEvent).message}`))
      setTimeout(() => res('timeout'), 5000)
    })
    w.terminate()
    expect(got).toBe('!')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('worker.ts loads with elysia not installed: an app without [actions] needs no elysia (R7)', () => {
  // A copy of src/ outside the repo with node_modules minus elysia/@elysia: the published-install shape.
  const pkg = join(import.meta.dir, '..')
  const d = mkdtempSync(join(tmpdir(), 'brust-noelysia-'))
  try {
    cpSync(join(pkg, 'src'), join(d, 'src'), { recursive: true })
    symlinkSync(join(pkg, 'native'), join(d, 'native'))
    mkdirSync(join(d, 'node_modules'))
    for (const n of readdirSync(join(pkg, 'node_modules')))
      if (n !== 'elysia' && n !== '@elysia') symlinkSync(join(pkg, 'node_modules', n), join(d, 'node_modules', n))
    const p = Bun.spawnSync([process.execPath, '-e', "await import('./src/worker.ts'); console.log('LOADED')"], {
      cwd: d,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BRUST_WORKER_ID: undefined },
    })
    expect(p.stderr.toString()).not.toMatch(/elysia/)
    expect(p.stdout.toString()).toContain('LOADED')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

// ---- L10: heap replies for loader / jobs / planned calls ----

/** A fake `HeapIo` + `planJobsBuf`: records what crossed. */
function fakeHeap(over: { cap?: number; accept?: boolean; planBuf?: (slot: number, buf: Uint8Array) => string } = {}) {
  const put: { slot: number; bytes: Uint8Array }[] = []
  const heap: HeapReply = {
    io: {
      takeBody: () => null,
      putReply: (slot, bytes) => {
        if (over.accept === false) return false
        put.push({ slot, bytes })
        return true
      },
    },
    planBuf: over.planBuf ?? (() => PLAN_DECLINED),
    cap: over.cap ?? 8_388_608,
  }
  return { heap, put }
}
const marker = (v: Uint8Array, n: number) => (n === 5 && v[0] === 0 ? new DataView(v.buffer, v.byteOffset + 1, 4).getUint32(0, true) : null)
const big = (bytes: number) => ({ blob: 'x'.repeat(bytes) })
const SLOT = 256 * 1024
const bigLoader = (bytes: number) => makeHandlers({ leaves: leaves({ child: async () => big(bytes) }), jobs: {} })

test('writeSlot: a reply that does not fit goes by heap when io+cap are given: marker [0x00][u32 LE n]', () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const { heap, put } = fakeHeap()
  const json = JSON.stringify(big(10_000))
  const n = writeSlot(view, 0, 1, json, heap.io, heap.cap)
  expect(n).toBe(5)
  expect(marker(view, n)).toBe(Buffer.byteLength(json))
  expect(put.length).toBe(1)
  expect(new TextDecoder().decode(put[0]?.bytes)).toBe(json)
})

test('writeSlot: over the cap, or declined by Rust → {error} naming the cap; no io → today\'s slot error', () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const json = JSON.stringify(big(10_000))
  const over = fakeHeap({ cap: 5000 })
  const a = writeSlot(view, 0, 1, json, over.heap.io, over.heap.cap)
  expect(dec(view, a)).toEqual({ error: `response too large: ${Buffer.byteLength(json)} > 5000 (maxLoaderResponseBytes)` })
  expect(over.put.length).toBe(0)
  const no = fakeHeap({ accept: false })
  const b = writeSlot(view, 0, 1, json, no.heap.io, no.heap.cap)
  // under the cap but declined by Rust: the message names the real reason, not the cap
  expect(dec(view, b).error).toBe(`heap reply declined: ${Buffer.byteLength(json)} bytes did not fit the 4096-byte slot and Rust refused the handover`)
  const c = writeSlot(view, 0, 1, json)
  expect(dec(view, c)).toEqual({ error: `response too large: ${Buffer.byteLength(json)} > 4096` })
})

test('writeSlot: a reply that fits never touches the heap', () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const { heap, put } = fakeHeap()
  const n = writeSlot(view, 0, 1, '{"a":1}', heap.io, heap.cap)
  expect(dec(view, n)).toEqual({ a: 1 })
  expect(put.length).toBe(0)
})

test('dispatch: a 300 KB loader reply crosses by heap (marker in the slot)', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const { heap, put } = fakeHeap()
  const d = makeDispatch(bigLoader(300_000), view, 1, undefined, heap)
  const n = await d('loader', JSON.stringify(ctx('r1')), 0)
  expect(marker(view, n)).toBe(put[0]?.bytes.length ?? -1)
  expect(JSON.parse(new TextDecoder().decode(put[0]?.bytes))).toEqual({ ok: true, data: big(300_000) })
})

test('dispatch: a 300 KB jobs reply crosses by heap', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const { heap, put } = fakeHeap()
  const h = makeHandlers({ leaves: leaves({}), jobs: { c: { precompute: () => big(300_000) } } })
  const d = makeDispatch(h, view, 1, undefined, heap)
  const n = await d('jobs', JSON.stringify({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'precompute', inputs: {} }] }), 0)
  expect(marker(view, n)).toBe(put[0]?.bytes.length ?? -1)
  expect(JSON.parse(new TextDecoder().decode(put[0]?.bytes)).results[0].value).toEqual(big(300_000))
})

test('dispatch: a planned loader call with a 300 KB ctx plans from the bytes (planJobsBuf), not the slot', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const seen: number[] = []
  const { heap, put } = fakeHeap({
    planBuf: (_slot, buf) => {
      seen.push(buf.length)
      return ''
    },
  })
  const noSlotPlan = (): string => {
    throw new Error('planJobs (slot) must not be called for an oversized ctx')
  }
  const d = makeDispatch(bigLoader(300_000), view, 1, noSlotPlan, heap)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(seen.length).toBe(1)
  expect(seen[0]).toBeGreaterThan(300_000)
  expect(dec(view, n)).toEqual({ planned: true })
  expect(put.length).toBe(0)
})

test('dispatch: planning declined for a 300 KB ctx hands the loader reply over by heap', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const { heap, put } = fakeHeap() // planBuf → PLAN_DECLINED
  const d = makeDispatch(bigLoader(300_000), view, 1, undefined, heap)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(marker(view, n)).toBe(put[0]?.bytes.length ?? -1)
  expect(JSON.parse(new TextDecoder().decode(put[0]?.bytes))).toEqual({ ok: true, data: big(300_000) })
})

test('dispatch: the final {planned, results} reply uses the heap fallback too', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const { heap, put } = fakeHeap()
  const plan = () => JSON.stringify({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'precompute', inputs: {} }] })
  const h = makeHandlers({ leaves: leaves({ child: async () => ({ team: ['a'] }) }), jobs: { c: { precompute: () => big(300_000) } } })
  const d = makeDispatch(h, view, 1, plan, heap)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(marker(view, n)).toBe(put[0]?.bytes.length ?? -1)
  expect(JSON.parse(new TextDecoder().decode(put[0]?.bytes)).planned).toBe(true)
})

test('dispatch: over the cap → {error} naming the cap (loader, planned ctx)', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(SLOT))
  const { heap, put } = fakeHeap({ cap: 262_144 })
  const d = makeDispatch(bigLoader(300_000), view, 1, undefined, heap)
  const a = await d('loader', JSON.stringify(ctx('r1')), 0)
  expect(dec(view, a).error).toMatch(/^response too large: \d+ > 262144 \(maxLoaderResponseBytes\)$/)
  const b = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(dec(view, b).error).toMatch(/> 262144 \(maxLoaderResponseBytes\)/)
  expect(put.length).toBe(0)
})

// ---- F464: res.headers ----

// biome-ignore lint/suspicious/noExplicitAny: loader fixtures
const chain3 = (root: any, mid: any, page: any) =>
  flattenRoutes(defineRoutes([{ Component: C, loader: root, children: [{ path: '/a', Component: C, loader: mid, children: [{ path: '/a/{id}', Component: C, loader: page }] }] }]))
    .leaves
// the leaf of a 3-level chain
type H = { res: { headers: Headers } }

test('res.headers: one Headers for the chain, in chain order; set replaces, append adds, repeated set-cookie stay pairs', async () => {
  const seen: Headers[] = []
  const h = makeHandlers({
    leaves: chain3(
      ({ res }: H) => { seen.push(res.headers); res.headers.set('Cache-Control', 'no-store'); res.headers.append('Set-Cookie', 'a=1'); res.headers.set('X-Level', 'root') },
      ({ res }: H) => { seen.push(res.headers); res.headers.append('Set-Cookie', 'b=2'); res.headers.append('Vary', 'Accept') },
      ({ res }: H) => { seen.push(res.headers); res.headers.set('X-Level', 'page'); res.headers.append('Vary', 'Cookie'); return { p: 1 } },
    ),
    jobs: {},
  })
  const r: unknown = await h.loader(ctx('r2'))
  expect(r).toEqual({
    ok: true,
    data: { p: 1 },
    headers: [['cache-control', 'no-store'], ['vary', 'Accept, Cookie'], ['x-level', 'page'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
  })
  expect(new Set(seen).size).toBe(1)
  const again: unknown = await h.loader(ctx('r2')) // a shared object would carry the cookies twice
  expect(again).toEqual(r)
})

test('res.headers: no header set, no headers key', async () => {
  const h = makeHandlers({ leaves: chain3(async () => ({}), undefined, async () => ({ x: 1 })), jobs: {} })
  expect(await h.loader(ctx('r2'))).toEqual({ ok: true, data: { x: 1 } })
})

test('res.headers go on every verdict: notFound, redirect, httpError (with its own headers option after)', async () => {
  const set = ({ res }: H) => { res.headers.set('Cache-Control', 'no-store'); res.headers.append('Set-Cookie', 'sid=; Max-Age=0') }
  const nf = makeHandlers({ leaves: chain3(set, undefined, async () => notFound({ w: 1 })), jobs: {} })
  expect(await nf.loader(ctx('r2'))).toEqual({ verdict: 'notFound', data: { w: 1 }, headers: [['cache-control', 'no-store'], ['set-cookie', 'sid=; Max-Age=0']] })
  const rd = makeHandlers({ leaves: chain3(set, ({ res }: H) => { res.headers.append('Set-Cookie', 'b=2'); return redirect('/login', 303) }, async () => ({ never: 1 })), jobs: {} })
  expect(await rd.loader(ctx('r2'))).toEqual({
    verdict: 'redirect',
    location: '/login',
    status: 303,
    headers: [['cache-control', 'no-store'], ['set-cookie', 'sid=; Max-Age=0'], ['set-cookie', 'b=2']],
  })
  const he = makeHandlers({ leaves: chain3(set, undefined, async () => httpError(429, 'slow', { headers: { 'Retry-After': '5' } })), jobs: {} })
  expect(await he.loader(ctx('r2'))).toEqual({
    verdict: 'httpError',
    status: 429,
    body: 'slow',
    headers: [['cache-control', 'no-store'], ['retry-after', '5'], ['set-cookie', 'sid=; Max-Age=0']],
  })
})

test('res.headers refuses the server\'s names: a throw naming it in dev, a warning and a drop in production', async () => {
  for (const name of ['Content-Type', 'content-length', 'Transfer-Encoding', 'Connection', 'Location']) {
    const page = ({ res }: H) => { res.headers.set('X-Ok', '1'); res.headers.append(name, 'x'); return {} }
    const dev = makeHandlers({ leaves: chain3(undefined, undefined, page), jobs: {}, dev: true })
    const r = (await dev.loader(ctx('r2'))) as { error: string }
    expect(r.error).toContain(`"${name}"`)
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const prod = makeHandlers({ leaves: chain3(undefined, undefined, page), jobs: {} })
    expect(await prod.loader(ctx('r2'))).toEqual({ ok: true, data: {}, headers: [['x-ok', '1']] })
    expect(String(warn.mock.calls[0]?.[0])).toContain(`"${name}"`)
    warn.mockRestore()
  }
  // set as well as append
  const dev = makeHandlers({ leaves: chain3(undefined, undefined, ({ res }: H) => { res.headers.set('location', '/x'); return {} }), jobs: {}, dev: true })
  expect(((await dev.loader(ctx('r2'))) as { error: string }).error).toContain('redirect()')
})

test('res.headers on a static render: the build is told every name, on a verdict too', async () => {
  const recs: unknown[] = []
  const h = makeHandlers({
    leaves: chain3(({ res }: H) => { res.headers.append('Set-Cookie', 'a=1'); res.headers.append('Set-Cookie', 'b=1') }, undefined, async () => redirect('/x')),
    jobs: {},
    ssg: (r) => recs.push(r),
  })
  await h.loader(ctx('r2'))
  expect(recs).toEqual([{ kind: 'headers', routeId: 'r2', path: '/items/7', names: ['set-cookie'] }])
})
