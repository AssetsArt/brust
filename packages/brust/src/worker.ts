// The Bun side of contract 7 (`crates/brust-server/src/protocol.rs`): requests arrive as inline
// JSON, responses go into this worker's SharedArrayBuffer slot (SAB rule, `dispatch.rs`). A
// handler NEVER rejects across the tsfn: every failure becomes `{error}` / `{id, error}`.
import { join, resolve } from 'node:path'
import { workerData } from 'node:worker_threads'
import { runFetch, setActionsApp, setActionsLimits } from './actions-bridge'
import { DEFAULT_MAX_RESPONSE_BYTES } from './actions/prefix'
import { planJobs, registerWorker } from './native'
import { installServerResolver, type StoreSnapshot } from './store/core-adapter'
import { collectSnapshot, getServerInstance, runInStoreContext, touchStores } from './store/server-context'
import { type FlatRoute, flattenRoutes, isHttpErrorTrigger, isVerdict, type LoaderReq, type Route, type Verdict } from './routes'

installServerResolver(getServerInstance)

// ---- wire shapes (protocol.rs, camelCase) ----

export interface LoaderRequest {
  routeId: string
  params: Record<string, string>
  path: string
  req: LoaderReq
  /** M3-P P6: the chain has jobs — plan them in this call (`planJobs`). Optional to honour. */
  plan?: boolean
}

export type LoaderResponse =
  | { ok: true; data: Record<string, unknown>; headers?: Record<string, string>; store?: StoreSnapshot | null }
  | { verdict: 'notFound'; data: unknown; store?: StoreSnapshot | null }
  | { verdict: 'redirect'; location: string; status: number }
  | { verdict: 'httpError'; status: number; body: string }
  | { error: string }

export type JobKind = 'precompute' | 'ssr'

export interface JobCall {
  /** Opaque, echoed back: `<componentId>/<jobId>[/<row>]` for a chain job,
   * `<parentId>/<childId>_<k>/<jobId>[/<row>]` for an inlined child instance (pipeline.rs `plan_one`). */
  id: string
  componentId: string
  kind: JobKind
  // biome-ignore lint/suspicious/noExplicitAny: job inputs are arbitrary JSON
  inputs: any
  /** ssr: the react component to render (D6). */
  target?: string
  row?: number
}

export interface JobsRequest {
  jobs: JobCall[]
}

export type JobResult = { id: string; value: unknown } | { id: string; error: string }

export interface JobsResponse {
  results: JobResult[]
}

/** The default export of `<dist>/<manifest.jobs_module>` (built by Task 6): component id → job fns. */
// biome-ignore lint/suspicious/noExplicitAny: props are whatever the component takes
export type JobsModule = Record<string, { precompute?: (props: any) => unknown; ssr?: (props: any) => string | Promise<string> }>

/** The slice of `manifest.json` the worker reads: ssr job `literals` (S6 amendment). */
export interface ManifestLike {
  routes?: { id: string; chain: string[] }[]
  components: Record<
    string,
    {
      jobs: { id: string; kind?: string; target?: string; literals?: Record<string, unknown> }[]
      children?: { id: string }[]
      stores?: string[]
    }
  >
  jobs_module?: string
  /** `brust build` (M3-F A3): the actions entry, relative to dist. Absent/null = no actions. */
  actions?: { entry: string; prefix: string; maxBodyBytes: number; maxResponseBytes?: number } | null
}

// ---- SAB slot writer ----

const enc = new TextEncoder()

/** Writes `json` as UTF-8 at the start of `slot`'s sub-region `[slot*sub, slot*sub+sub)`,
 * `sub = floor(view.byteLength / slots)`; returns the byte length (> 0, ≤ sub). ONE copy: the
 * encoder writes straight into the slot (M3-P P1); it stops at the last whole code point that
 * fits, so `read < json.length` means "did not fit" and the neighbouring slot is never touched.
 * A response that does not fit is replaced by a small `{"error":"response too large: <n> > <sub>"}`
 * (`n` = its exact UTF-8 length, computed only on this path). */
export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const r = enc.encodeInto(json, dst)
  if (r.read === json.length) return r.written
  const err = JSON.stringify({ error: `response too large: ${Buffer.byteLength(json)} > ${sub}` })
  const e = enc.encodeInto(err, dst)
  if (e.read === err.length) return e.written
  // Not even the message fits: the first `sub` bytes of a fixed one (ASCII, so byte = char).
  return enc.encodeInto('{"error":"too large"}', dst).written
}

/** `planJobs` (napi): the misses' JobsRequest JSON, '' (every job hit) or PLAN_DECLINED. */
export type PlanJobs = (slot: number, len: number) => string
/** `planJobs` declined: the loader response already in the slot is the answer (Rust plans after the call). */
export const PLAN_DECLINED = '!'
const PLANNED = { planned: true } as const

function toJson(out: unknown): string {
  try {
    return JSON.stringify(out)
  } catch (e) {
    return JSON.stringify({ error: `response not serialisable: ${String(e)}` })
  }
}

// ---- literals (S6 amendment: the worker merges an ssr job's `literals` over `call.inputs`) ----

/** `"<componentId>/<jobId>"` → that job record's `literals` (only records that carry some). */
export function literalsIndex(manifest: ManifestLike | undefined): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const [cid, c] of Object.entries(manifest?.components ?? {}))
    for (const j of c.jobs ?? []) if (j.literals && Object.keys(j.literals).length > 0) out.set(`${cid}/${j.id}`, j.literals)
  return out
}

/** The manifest job id of a call: the segment after `componentId` in a chain id
 * (`<cid>/<jobId>[/<row>]`), else the third segment of a child-instance id
 * (`<parentId>/<cid>_<k>/<jobId>[/<row>]`). */
export function jobIdOf(call: Pick<JobCall, 'id' | 'componentId'>): string | undefined {
  const parts = call.id.split('/')
  return parts[0] === call.componentId ? parts[1] : parts[2]
}

// ---- touched stores (M3-F D4) ----

/** route id -> sorted unique union of `stores` over the route's chain, walking each component's
 * `children[].id` and `jobs[].target` transitively. Routes with an empty union are absent. */
export function routeStoresIndex(manifest: ManifestLike | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const comps = manifest?.components ?? {}
  for (const r of manifest?.routes ?? []) {
    const acc = new Set<string>()
    const seen = new Set<string>()
    const walk = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const c = comps[id]
      if (!c) return
      for (const p of c.stores ?? []) acc.add(p)
      for (const k of c.children ?? []) walk(k.id)
      for (const j of c.jobs ?? []) if (j.target) walk(j.target)
    }
    for (const id of r.chain ?? []) walk(id)
    if (acc.size > 0) out.set(r.id, [...acc].sort())
  }
  return out
}

/** R1: `store` is assigned only when a store was touched; absent otherwise. */
function withStore<T extends LoaderResponse>(r: T): T {
  const s = collectSnapshot()
  if (s) (r as { store?: StoreSnapshot | null }).store = s
  return r
}

// ---- handlers ----

/** `parent`: the data the chain merged before the verdict. A notFound renders the route's
 * template (layouts included), so the layouts' data stays under the verdict's own keys. */
function verdictJson(v: Verdict, parent: Record<string, unknown>): LoaderResponse {
  if (v.status === 404) {
    const own = v.data ?? {}
    return { verdict: 'notFound', data: typeof own === 'object' && !Array.isArray(own) ? { ...parent, ...own } : own }
  }
  return { verdict: 'redirect', location: v.headers?.Location ?? '/', status: v.status }
}

export interface Handlers {
  loader(req: LoaderRequest): Promise<LoaderResponse>
  jobs(req: JobsRequest): Promise<JobsResponse>
}

/** `leaves` from `flattenRoutes` (ids must match the manifest's route ids); `jobs` the jobs
 * module; `manifest` supplies ssr `literals` (omit → no merge). */
export function makeHandlers(opts: {
  leaves: FlatRoute[]
  jobs: JobsModule
  manifest?: ManifestLike
  /** `jobs.js` `stores` table (R2): C3 path -> module namespace. */
  stores?: Record<string, object>
}): Handlers {
  const byId = new Map(opts.leaves.map((l) => [l.id, l]))
  const literals = literalsIndex(opts.manifest)
  const jobs = opts.jobs
  const storeIdx = routeStoresIndex(opts.manifest)
  const storeTable = opts.stores ?? {}

  async function runJob(call: JobCall): Promise<JobResult> {
    const owner = call.kind === 'ssr' ? (call.target ?? call.componentId) : call.componentId // D6
    const fn = jobs[owner]?.[call.kind]
    if (typeof fn !== 'function') return { id: call.id, error: `no ${call.kind} job for component ${owner}` }
    try {
      let props = call.inputs
      if (call.kind === 'ssr') {
        const jid = jobIdOf(call)
        const lit = jid === undefined ? undefined : literals.get(`${call.componentId}/${jid}`)
        if (lit) props = { ...(props ?? {}), ...lit }
        // Precompute runs outside any scope (D8); ssr runs in a scope seeded from `__store`, which props never see.
        const seed = (props?.__store ?? null) as StoreSnapshot | null
        if (props && '__store' in props) {
          const { __store: _, ...rest } = props
          props = rest
        }
        const p = props
        return { id: call.id, value: await runInStoreContext(() => fn(p), seed) }
      }
      return { id: call.id, value: await fn(props) }
    } catch (e) {
      return { id: call.id, error: String(e) }
    }
  }

  return {
    // 0.1.x `runNativeChainLoaders`: root → leaf, flat merge (later keys win), first verdict stops
    // (a notFound keeps what the chain merged so far: verdictJson).
    async loader(req) {
      const leaf = byId.get(req.routeId)
      if (!leaf) return { error: `unknown routeId ${req.routeId}` }
      // One object for the whole chain: each level's keys are assigned INTO it (later keys win,
      // first-seen key order — what `{...merged, ...r}` produced) instead of re-spreading every
      // key once per level (M3-P P1). `merged` is fresh per call; a loader's own object is never
      // written to. Null prototype: with no `__proto__` setter to hit, an own "__proto__" key in a
      // loader's data is assigned as data, as the spread copied it.
      return runInStoreContext(async () => {
        const merged: Record<string, unknown> = Object.create(null)
        try {
          const touch = storeIdx.get(req.routeId)
          if (touch) touchStores(touch, storeTable)
          for (const node of leaf.chain) {
            if (!node.loader) continue
            let r: unknown
            try {
              r = await node.loader({ params: req.params, path: req.path, req: req.req })
            } catch (e) {
              if (isHttpErrorTrigger(e)) return { verdict: 'httpError', status: e.status, body: e.body } as LoaderResponse
              throw e
            }
            if (isVerdict(r)) {
              const v = verdictJson(r, merged)
              return 'verdict' in v && v.verdict === 'notFound' ? withStore(v) : v
            }
            if (r && typeof r === 'object') Object.assign(merged, r)
          }
          return withStore({ ok: true, data: merged } as LoaderResponse)
        } catch (e) {
          return { error: String(e) } as LoaderResponse
        }
      })
    },
    // One request carries every job of the page; a per-job failure keeps the other results.
    async jobs(req) {
      return { results: await Promise.all((req.jobs ?? []).map(runJob)) }
    },
  }
}

/** The tsfn callback for `registerWorker`. Never rejects: a parse error, an unknown kind or a
 * throwing handler is written to the slot as `{error}`. A loader request with `plan: true` whose
 * chain answered `ok` is planned in the same call (`plan`, the napi `planJobs` by default — the
 * addon is touched only then). */
export function makeDispatch(h: Handlers, view: Uint8Array, slots: number, plan: PlanJobs = planJobs) {
  return async (kind: string, requestJson: string, slot: number): Promise<number> => {
    if (kind === 'fetch') return runFetch(requestJson, view, slot, slots)
    let out: unknown
    try {
      const req = JSON.parse(requestJson)
      if (kind === 'loader') {
        out = await h.loader(req)
        if (req.plan === true && (out as { ok?: unknown }).ok === true) {
          // One round trip (M3-P P6): the ctx goes to Rust through this slot, synchronously, and only
          // the jobs Rust found missing run here; the final answer replaces it in the same slot.
          const json = toJson(out)
          const n = writeSlot(view, slot, slots, json)
          const misses = plan(slot, n)
          if (misses === PLAN_DECLINED) return n
          out = misses === '' ? PLANNED : { planned: true, results: (await h.jobs(JSON.parse(misses))).results }
        }
      } else if (kind === 'jobs') out = await h.jobs(req)
      else out = { error: `unknown call kind ${kind}` }
    } catch (e) {
      out = { error: String(e) }
    }
    return writeSlot(view, slot, slots, toJson(out))
  }
}

// ---- worker entry ----

export const SLOT_BYTES = 256 * 1024

export interface StartWorkerOptions {
  /** The response buffer to register (`SLOT_BYTES * slots` bytes). `run()` allocates it on the
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
  const manifest = (await Bun.file(join(dist, 'manifest.json')).json()) as ManifestLike
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
  sab = opts.sab ?? new SharedArrayBuffer(SLOT_BYTES * slots)
  view = new Uint8Array(sab)
  const handlers = makeHandlers({
    leaves: flattenRoutes(routes).leaves,
    jobs,
    manifest,
    stores: (jobsMod.stores ?? {}) as Record<string, object>,
  })
  return registerWorker(view, slots, makeDispatch(handlers, view, slots))
}

// Auto-start only inside a Bun `Worker` spawned by `run()` (BRUST_WORKER_ID set). Not
// `import.meta.main`: Bun runs a Worker entry with `import.meta.main === false`.
if (process.env.BRUST_WORKER_ID !== undefined && !Bun.isMainThread)
  await startWorker({ sab: (workerData as { sab?: SharedArrayBuffer } | null)?.sab })
