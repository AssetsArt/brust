// The Bun side of contract 7 (`crates/brust-server/src/protocol.rs`): requests arrive as inline
// JSON, responses go into this worker's SharedArrayBuffer slot (SAB rule, `dispatch.rs`). A
// handler NEVER rejects across the tsfn: every failure becomes `{error}` / `{id, error}`.
import { join, resolve } from 'node:path'
import { registerWorker } from './native'
import { type FlatRoute, flattenRoutes, isHttpErrorTrigger, isVerdict, type LoaderReq, type Route, type Verdict } from './routes'

// ---- wire shapes (protocol.rs, camelCase) ----

export interface LoaderRequest {
  routeId: string
  params: Record<string, string>
  path: string
  req: LoaderReq
}

export type LoaderResponse =
  | { ok: true; data: Record<string, unknown>; headers?: Record<string, string> }
  | { verdict: 'notFound'; data: unknown }
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
  components: Record<string, { jobs: { id: string; kind?: string; literals?: Record<string, unknown> }[] }>
  jobs_module?: string
}

// ---- SAB slot writer ----

const enc = new TextEncoder()

/** Writes `json` as UTF-8 at the start of `slot`'s sub-region `[slot*sub, slot*sub+sub)`,
 * `sub = floor(view.byteLength / slots)`; returns the byte length (> 0, ≤ sub). A response that
 * does not fit is replaced by a small `{"error":"response too large: <n> > <sub>"}`, so the
 * neighbouring slot is never touched. */
export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  let bytes = enc.encode(json)
  if (bytes.byteLength > sub) {
    bytes = enc.encode(JSON.stringify({ error: `response too large: ${bytes.byteLength} > ${sub}` }))
    if (bytes.byteLength > sub) bytes = enc.encode('{"error":"too large"}').subarray(0, sub)
  }
  view.set(bytes, slot * sub)
  return bytes.byteLength
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

// ---- handlers ----

function verdictJson(v: Verdict): LoaderResponse {
  if (v.status === 404) return { verdict: 'notFound', data: v.data ?? {} }
  return { verdict: 'redirect', location: v.headers?.Location ?? '/', status: v.status }
}

export interface Handlers {
  loader(req: LoaderRequest): Promise<LoaderResponse>
  jobs(req: JobsRequest): Promise<JobsResponse>
}

/** `leaves` from `flattenRoutes` (ids must match the manifest's route ids); `jobs` the jobs
 * module; `manifest` supplies ssr `literals` (omit → no merge). */
export function makeHandlers(opts: { leaves: FlatRoute[]; jobs: JobsModule; manifest?: ManifestLike }): Handlers {
  const byId = new Map(opts.leaves.map((l) => [l.id, l]))
  const literals = literalsIndex(opts.manifest)
  const jobs = opts.jobs

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
      }
      return { id: call.id, value: await fn(props) }
    } catch (e) {
      return { id: call.id, error: String(e) }
    }
  }

  return {
    // 0.1.x `runNativeChainLoaders`: root → leaf, flat merge (later keys win), first verdict stops.
    async loader(req) {
      const leaf = byId.get(req.routeId)
      if (!leaf) return { error: `unknown routeId ${req.routeId}` }
      let merged: Record<string, unknown> = {}
      try {
        for (const node of leaf.chain) {
          if (!node.loader) continue
          let r: unknown
          try {
            r = await node.loader({ params: req.params, path: req.path, req: req.req })
          } catch (e) {
            if (isHttpErrorTrigger(e)) return { verdict: 'httpError', status: e.status, body: e.body }
            throw e
          }
          if (isVerdict(r)) return verdictJson(r)
          if (r && typeof r === 'object') merged = { ...merged, ...(r as Record<string, unknown>) }
        }
        return { ok: true, data: merged }
      } catch (e) {
        return { error: String(e) }
      }
    },
    // One request carries every job of the page; a per-job failure keeps the other results.
    async jobs(req) {
      return { results: await Promise.all((req.jobs ?? []).map(runJob)) }
    },
  }
}

/** The tsfn callback for `registerWorker`. Never rejects: a parse error, an unknown kind or a
 * throwing handler is written to the slot as `{error}`. */
export function makeDispatch(h: Handlers, view: Uint8Array, slots: number) {
  return async (kind: string, requestJson: string, slot: number): Promise<number> => {
    let out: unknown
    try {
      const req = JSON.parse(requestJson)
      if (kind === 'loader') out = await h.loader(req)
      else if (kind === 'jobs') out = await h.jobs(req)
      else out = { error: `unknown call kind ${kind}` }
    } catch (e) {
      out = { error: String(e) }
    }
    let json: string
    try {
      json = JSON.stringify(out)
    } catch (e) {
      json = JSON.stringify({ error: `response not serialisable: ${String(e)}` })
    }
    return writeSlot(view, slot, slots, json)
  }
}

// ---- worker entry ----

export const SLOT_BYTES = 256 * 1024

// Rooted for the worker's lifetime: the server reads responses out of this buffer.
let sab: SharedArrayBuffer | null = null
let view: Uint8Array | null = null

/** Boots one Bun worker: env `BRUST_WORKER_ID`, `BRUST_RENDER_SLOTS` (default 1),
 * `BRUST_DIST_DIR` (reads `manifest.json` + its `jobs_module`), `BRUST_APP_ENTRY` (the routes
 * module: `export const routes` or default export). Returns the worker index. */
export async function startWorker(): Promise<number> {
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
  sab = new SharedArrayBuffer(SLOT_BYTES * slots)
  view = new Uint8Array(sab)
  const handlers = makeHandlers({ leaves: flattenRoutes(routes).leaves, jobs, manifest })
  return registerWorker(view, slots, makeDispatch(handlers, view, slots))
}

// Auto-start only inside a Bun `Worker` spawned by `run()` (BRUST_WORKER_ID set). Not
// `import.meta.main`: Bun runs a Worker entry with `import.meta.main === false`.
if (process.env.BRUST_WORKER_ID !== undefined && !Bun.isMainThread) await startWorker()
