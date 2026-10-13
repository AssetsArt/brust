// The Bun side of contract 7 (`crates/brust-server/src/protocol.rs`): requests arrive as inline
// JSON, responses go into this worker's SharedArrayBuffer slot (SAB rule, `dispatch.rs`). A
// handler NEVER rejects across the tsfn: every failure becomes `{error}` / `{id, error}`.
import { appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { workerData } from 'node:worker_threads'
import { type HeapIo, runFetch, setActionsApp, setActionsLimits } from './actions-bridge'
import { DEFAULT_MAX_RESPONSE_BYTES } from './actions/prefix'
import { type CacheBridgeDeps, runCache } from './cache-adapter/bridge'
import type { CacheManifest } from './cache-adapter/load'
import { type Handlers, type JobsModule, type ManifestLike, makeHandlers, type SsgRecord, toJson } from './handlers'
import { cacheClear, cacheL2Count, cacheReplay, planJobs, planJobsBuf, putFetchReply, registerWorker, takeFetchBody } from './native'
import { flattenRoutes, type Route } from './routes'

export * from './handlers'

// ---- SAB slot writer ----

const enc = new TextEncoder()

/** L10: the default `maxLoaderResponseBytes` (config.ts keeps the range). */
export const DEFAULT_MAX_LOADER_RESPONSE_BYTES = 8_388_608

/** L10: a reply too large for the slot crosses by heap: `HeapIo.putReply` hands Rust the bytes, and the slot holds
 * the 5-byte marker `[0x00][u32 LE n]` (JSON never starts with 0x00). `cap` = `maxLoaderResponseBytes`. */
export const HEAP_MARKER_BYTES = 5
export interface HeapReply {
  io: HeapIo
  /** `planJobsBuf` (napi): plan a loader response handed over directly. */
  planBuf: (slot: number, buf: Uint8Array) => string
  /** Default: the worker's `maxLoaderResponseBytes` (env `BRUST_MAX_LOADER_RESPONSE_BYTES`, 8 MiB). */
  cap?: number
}
const nativeHeap: HeapReply = { io: cacheHeapIo(), planBuf: (slot, buf) => planJobsBuf(slot, buf) }
let loaderCap = DEFAULT_MAX_LOADER_RESPONSE_BYTES

/** Writes `json` as UTF-8 at the start of `slot`'s sub-region `[slot*sub, slot*sub+sub)`,
 * `sub = floor(view.byteLength / slots)`; returns the byte length (> 0, ≤ sub). ONE copy: the
 * encoder writes straight into the slot (M3-P P1); it stops at the last whole code point that
 * fits, so `read < json.length` means "did not fit" and the neighbouring slot is never touched.
 * A response that does not fit goes by heap when `io` and `cap` are given (L10): encoded once, handed to
 * Rust with `io.putReply`, and the slot holds the 5-byte marker. Over `cap` (or declined), or with no `io`, it is
 * replaced by a small `{"error":"response too large: <n> > <limit>"}` (`n` = its exact UTF-8 length, computed
 * only on this path). */
export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string, io?: HeapIo, cap?: number): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const r = enc.encodeInto(json, dst)
  if (r.read === json.length) return r.written
  let why = `response too large: ${Buffer.byteLength(json)} > ${sub}`
  if (io && cap !== undefined && sub >= HEAP_MARKER_BYTES) {
    const bytes = enc.encode(json)
    const n = heapMarker(dst, slot, bytes, io, cap)
    if (n > 0) return n
    // Name the real reason: over the cap, or a put Rust declined while under it (idle slot, a second put).
    why = bytes.length > cap ? `response too large: ${bytes.length} > ${cap} (maxLoaderResponseBytes)` : `heap reply declined: ${bytes.length} bytes did not fit the ${sub}-byte slot and Rust refused the handover`
  }
  const err = JSON.stringify({ error: why })
  const e = enc.encodeInto(err, dst)
  if (e.read === err.length) return e.written
  // Not even the message fits: the first `sub` bytes of a fixed one (ASCII, so byte = char).
  return enc.encodeInto('{"error":"too large"}', dst).written
}

/** Hand `bytes` to Rust and write the marker at `dst`; 0 when over `cap` or Rust declined. */
function heapMarker(dst: Uint8Array, slot: number, bytes: Uint8Array, io: HeapIo, cap: number): number {
  if (bytes.length > cap || !io.putReply(slot, bytes)) return 0
  dst[0] = 0
  new DataView(dst.buffer, dst.byteOffset + 1, 4).setUint32(0, bytes.length, true)
  return HEAP_MARKER_BYTES
}

/** `planJobs` (napi): the misses' JobsRequest JSON, '' (every job hit) or PLAN_DECLINED. */
export type PlanJobs = (slot: number, len: number) => string
/** `planJobs` declined: the loader response already in the slot is the answer (Rust plans after the call). */
export const PLAN_DECLINED = '!'
const PLANNED = { planned: true } as const

/** The tsfn callback for `registerWorker`. Never rejects: a parse error, an unknown kind or a
 * throwing handler is written to the slot as `{error}`. A loader request with `plan: true` whose
 * chain answered `ok` is planned in the same call (`plan`, the napi `planJobs` by default — the
 * addon is touched only then). A loader/jobs/planned reply that does not fit the slot crosses by heap
 * (`heap`, the napi addon by default; L10). */
export function makeDispatch(h: Handlers, view: Uint8Array, slots: number, plan: PlanJobs = planJobs, heap: HeapReply = nativeHeap) {
  const cap = () => heap.cap ?? loaderCap
  return async (kind: string, requestJson: string, slot: number): Promise<number> => {
    if (kind === 'fetch') return runFetch(requestJson, view, slot, slots)
    if (kind === 'cache') return runCache(requestJson, view, slot, slots, cacheHeapIo(), cacheDeps)
    let out: unknown
    try {
      const req = JSON.parse(requestJson)
      if (kind === 'loader') {
        out = await h.loader(req)
        if (req.plan === true && (out as { ok?: unknown }).ok === true) {
          // One round trip (M3-P P6): the ctx goes to Rust through this slot, synchronously, and only
          // the jobs Rust found missing run here; the final answer replaces it in the same slot.
          const json = toJson(out)
          const sub = Math.floor(view.byteLength / Math.max(1, slots))
          const dst = view.subarray(slot * sub, slot * sub + sub)
          const w = enc.encodeInto(json, dst)
          let misses: string
          if (w.read === json.length) {
            misses = plan(slot, w.written)
            if (misses === PLAN_DECLINED) return w.written
          } else {
            // L10: too large for the slot — plan from the bytes directly; a declined plan hands them over as the answer.
            const bytes = enc.encode(json)
            if (bytes.length > cap()) return writeSlot(view, slot, slots, json, heap.io, cap())
            misses = heap.planBuf(slot, bytes)
            if (misses === PLAN_DECLINED) return writeSlot(view, slot, slots, json, heap.io, cap())
          }
          out = misses === '' ? PLANNED : { planned: true, results: (await h.jobs(JSON.parse(misses))).results }
        }
      } else if (kind === 'jobs') out = await h.jobs(req)
      else out = { error: `unknown call kind ${kind}` }
    } catch (e) {
      out = { error: String(e) }
    }
    return writeSlot(view, slot, slots, toJson(out), heap.io, cap())
  }
}

// ---- cache adapter (the `cache` call kind) ----

function cacheHeapIo(): HeapIo {
  return { takeBody: (slot) => takeFetchBody(slot), putReply: (slot, body) => putFetchReply(slot, body) }
}
const count = (name: string) => void cacheL2Count(name)
let cacheDeps: CacheBridgeDeps = { store: undefined, getTimeoutMs: 50, maxBodyBytes: 1_048_576, count }

/** The `cache` call's store (tests; `startWorker` sets it from `manifest.cache`). */
export function setCacheBridge(d: CacheBridgeDeps): void {
  cacheDeps = d
}

/** Load `manifest.cache`'s adapter in this worker (R8): a custom module from dist, a built-in from the
 * app root; `init`, then `cache.invalidate` publishes through it. Worker 0 also subscribes after
 * registering (R10). */
async function startCacheAdapter(m: CacheManifest, dist: string, appDir: string, workerId: number) {
  const { loadAdapter } = await import('./cache-adapter/load')
  const { setCacheRuntime } = await import('./cache-adapter/runtime')
  const adapter = await loadAdapter(m, 'bun', (spec, builtin) => import(builtin ? Bun.resolveSync(spec, appDir) : join(dist, spec)), process.env)
  await adapter.init?.({ namespace: m.namespace, buildId: m.buildId, runtime: 'bun', workerId })
  const origin = process.env.BRUST_CACHE_ORIGIN || crypto.randomUUID()
  setCacheRuntime({ adapter, origin, defer: (p) => void p.catch(() => {}), count, replay: (args, seq) => void cacheReplay(args, seq) })
  setCacheBridge({ store: adapter.store, getTimeoutMs: m.getTimeoutMs, maxBodyBytes: m.maxBodyBytes, count })
  return { adapter, origin }
}

// ---- static output (gaps round R9.5) ----

/** Appends each record as one JSON line to `file` (every worker of the render appends to it). */
function ssgLog(file: string): (r: SsgRecord) => void {
  return (r) => appendFileSync(file, `${JSON.stringify(r)}\n`)
}

// ---- worker entry ----

/** The default response slot (`slotBytes`, config.ts: 64 KiB..16 MiB). */
export const SLOT_BYTES = 256 * 1024

export interface StartWorkerOptions {
  /** The response buffer to register (`slotBytes * slots` bytes). `run()` allocates it on the
   * MAIN thread and keeps it for the process lifetime, passing it as `workerData.sab`: the Rust
   * dispatcher holds a raw pointer into it until the process exits, so its backing store must not
   * die with this worker (`crates/brust-napi/src/dispatch.rs` BufPtr). Absent (tests, a worker
   * started by hand) → allocated here and rooted in module scope. */
  sab?: SharedArrayBuffer
}

// Rooted for the worker's lifetime: the server reads responses out of this buffer.
let sab: SharedArrayBuffer | null = null
let view: Uint8Array | null = null

/** Boots one Bun worker: env `BRUST_WORKER_ID`, `BRUST_RENDER_SLOTS` (default 1),
 * `BRUST_DIST_DIR` (reads `manifest.json` + its `jobs_module`), `BRUST_APP_ENTRY` (the routes
 * module: `export const routes` or default export). Returns the worker index. */
export async function startWorker(opts: StartWorkerOptions = {}): Promise<number> {
  const env = process.env
  const slots = Math.max(1, Number.parseInt(env.BRUST_RENDER_SLOTS ?? '1', 10) || 1)
  const dist = resolve(env.BRUST_DIST_DIR ?? 'dist')
  const entry = env.BRUST_APP_ENTRY
  if (!entry) throw new Error('BRUST_APP_ENTRY is not set')
  const manifest = (await Bun.file(join(dist, 'manifest.json')).json()) as ManifestLike & { cache?: CacheManifest | null }
  const app = await import(resolve(entry))
  const routes = (app.routes ?? app.default) as Route[] | undefined
  if (!Array.isArray(routes)) throw new Error(`${entry} exports no routes (export const routes or default)`)
  const jobsMod = await import(join(dist, manifest.jobs_module ?? 'jobs.js'))
  const jobs = (jobsMod.default ?? jobsMod) as JobsModule
  if (manifest.actions) {
    // Lazy: elysia is an optional peer, so an app without [actions] must boot without it installed (R7).
    const { loadActionsApp } = await import('./actions/load')
    setActionsApp(await loadActionsApp(join(dist, manifest.actions.entry), manifest.actions.prefix))
    setActionsLimits({ maxResponseBytes: manifest.actions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES })
  }
  loaderCap = Number.parseInt(env.BRUST_MAX_LOADER_RESPONSE_BYTES ?? '', 10) || DEFAULT_MAX_LOADER_RESPONSE_BYTES
  const slotBytes = Number.parseInt(env.BRUST_SLOT_BYTES ?? '', 10) || SLOT_BYTES
  const workerId = Number.parseInt(env.BRUST_WORKER_ID ?? '0', 10) || 0
  const l2 = manifest.cache ? await startCacheAdapter(manifest.cache, dist, dirname(resolve(entry)), workerId) : null
  sab = opts.sab ?? new SharedArrayBuffer(slotBytes * slots)
  view = new Uint8Array(sab)
  const handlers = makeHandlers({
    leaves: flattenRoutes(routes).leaves,
    jobs,
    manifest,
    stores: (jobsMod.stores ?? {}) as Record<string, object>,
    ...(env.BRUST_SSG === '1' && env.BRUST_SSG_LOG ? { ssg: ssgLog(env.BRUST_SSG_LOG) } : {}),
  })
  const id = registerWorker(view, slots, makeDispatch(handlers, view, slots))
  if (l2 && env.BRUST_WORKER_ID === '0') {
    const { startSubscriber } = await import('./cache-adapter/runtime')
    await startSubscriber(l2.adapter, l2.origin, { replay: (args, seq) => void cacheReplay(args, seq), clear: () => void cacheClear(), count })
  }
  return id
}

// Auto-start only inside a Bun `Worker` spawned by `run()` (BRUST_WORKER_ID set). Not
// `import.meta.main`: Bun runs a Worker entry with `import.meta.main === false`.
if (process.env.BRUST_WORKER_ID !== undefined && !Bun.isMainThread)
  await startWorker({ sab: (workerData as { sab?: SharedArrayBuffer } | null)?.sab })
