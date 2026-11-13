// The host-agnostic half of the worker (M4-CF lane 4): wire shapes + `makeHandlers`. No Bun, no
// napi, no `node:*` — the Cloudflare entry imports it through `@brust/core/server-handlers`.
// `worker.ts` re-exports everything here, so existing importers are unchanged.
import { installServerResolver, type StoreSnapshot } from './store/core-adapter'
import { collectSnapshot, getServerInstance, runInStoreContext, touchStores } from './store/server-context'
import { NAVIGATION_MODULE } from './store/builtin'
import { type FlatRoute, isHttpErrorTrigger, isVerdict, type LoaderReq, type Route, type RuntimeComponents, type Verdict } from './routes'

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

/** Response headers as `[name, value]` pairs: a repeated name (`set-cookie`) stays repeated. */
export type HeaderPairs = [string, string][]

export type LoaderResponse =
  | { ok: true; data: Record<string, unknown>; headers?: HeaderPairs; store?: StoreSnapshot | null }
  | { verdict: 'notFound'; data: unknown; headers?: HeaderPairs; store?: StoreSnapshot | null }
  | { verdict: 'redirect'; location: string; status: number; headers?: HeaderPairs }
  | { verdict: 'httpError'; status: number; body: string; contentType: string; headers?: HeaderPairs }
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

/** F519 (R5.2): every cold `<Dynamic>` ref of one render, in one call. F546 (R4): plus the island slots of that render
 * that need HTML (`renders`, under the page render's id `page`); absent when there are none. */
export interface ComponentRequest {
  refs: string[]
  renders?: RenderItem[]
  page?: string
}

/** F546: one `components.render(ref, props)` the page needs; `key` names it in the answer. */
export interface RenderItem {
  ref: string
  key: string
  props: Record<string, unknown>
}

/** One answer per ref: the artifact, `missing` (the resolver returned null), or what the resolver threw. */
export type ComponentResult = { ref: string; artifact: unknown } | { ref: string; missing: true } | { ref: string; error: string }

/** F546: one answer per render whose ref is an island artifact: its HTML (`null` = none) or what `render` threw. */
export type HtmlResult = { ref: string; key: string; html: string | null } | { ref: string; key: string; error: string }

export interface ComponentResponse {
  results: ComponentResult[]
  html?: HtmlResult[]
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
      /** F519 (R4.4): the component's own template holds a `<Dynamic>` slot. */
      dynamic?: boolean
    }
  >
  /** F517 (R1.3): exposed modules and the stores they define (name -> module). Absent = no runtime components. */
  runtime?: { exposed?: Record<string, string>; stores?: Record<string, string> } | null
  /** The build id an artifact must be compiled for (`assets.build`). */
  assets?: { build?: string }
  jobs_module?: string
  /** `brust build` (M3-F A3): the actions entry, relative to dist. Absent/null = no actions. */
  actions?: { entry: string; prefix: string; maxBodyBytes: number; maxResponseBytes?: number; stream?: string[] } | null
}

export function toJson(out: unknown): string {
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
 * `children[].id` and `jobs[].target` transitively. Routes with an empty union are absent. F519 (R5.8): a route whose
 * chain holds a `<Dynamic>` slot also touches every exposed store module (`runtime.stores`), so whatever a runtime
 * component reads is in the page's snapshot. */
export function routeStoresIndex(manifest: ManifestLike | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const comps = manifest?.components ?? {}
  const exposed = Object.values(manifest?.runtime?.stores ?? {})
  for (const r of manifest?.routes ?? []) {
    const acc = new Set<string>()
    const seen = new Set<string>()
    const walk = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const c = comps[id]
      if (!c) return
      for (const p of c.stores ?? []) acc.add(p)
      if (c.dynamic) for (const p of exposed) acc.add(p)
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

// ---- response headers (F464) ----

/** Names the server owns: the framing, the page's type, and a redirect's target (`redirect()`). */
const REFUSED_HEADERS = new Set(['content-type', 'content-length', 'transfer-encoding', 'connection', 'location'])

const refusedMessage = (name: string) =>
  `a loader cannot set "${name}" (the server sets it${name.trim().toLowerCase() === 'location' ? '; use redirect()' : ''})`

/** `res.headers`: a `Headers` that refuses the server's names, by a throw in dev (the loader fails with a 500 that
 * names it) and by a warning in production (the call does nothing). */
class LoaderHeaders extends Headers {
  constructor(private readonly dev: boolean) {
    super()
  }
  private allowed(name: string): boolean {
    if (!REFUSED_HEADERS.has(name.trim().toLowerCase())) return true
    const msg = `res.headers: ${refusedMessage(name)}`
    if (this.dev) throw new Error(msg)
    console.warn(`[brust] warning ${msg}; dropped`)
    return false
  }
  override set(name: string, value: string): void {
    if (this.allowed(name)) super.set(name, value)
  }
  override append(name: string, value: string): void {
    if (this.allowed(name)) super.append(name, value)
  }
}

/** The wire pairs, absent when empty. `Set-Cookie` one pair per cookie (iteration would join them). */
function headerPairs(h: Headers): HeaderPairs | undefined {
  const out: HeaderPairs = []
  for (const [k, v] of h) if (k !== 'set-cookie') out.push([k, v])
  for (const c of h.getSetCookie()) out.push(['set-cookie', c])
  return out.length > 0 ? out : undefined
}

/** `r` with `headers` set when there are any. */
function withHeaders<T extends LoaderResponse>(r: T, h: Headers): T {
  const pairs = headerPairs(h)
  if (pairs) (r as { headers?: HeaderPairs }).headers = pairs
  return r
}

/** `parent`: the data the chain merged before the verdict. A notFound renders the route's
 * template (layouts included), so the layouts' data stays under the verdict's own keys. */
function verdictJson(v: Verdict, parent: Record<string, unknown>): LoaderResponse {
  if (v.status === 404) {
    const own = v.data ?? {}
    return { verdict: 'notFound', data: typeof own === 'object' && !Array.isArray(own) ? { ...parent, ...own } : own }
  }
  return { verdict: 'redirect', location: v.headers?.Location ?? '/', status: v.status }
}

/** What a loader did during a static render (gaps round R9.5) that a static file cannot honour. */
export type SsgRecord =
  | { kind: 'read'; routeId: string; path: string; field: 'headers' | 'cookies' | 'search'; key: string }
  | { kind: 'headers'; routeId: string; path: string; names: string[] }

/** R9.5: the request a loader sees while rendering static output: a visitor with no headers, cookies
 * or query. Every read of `headers` / `cookies` / `search` (a key, `in`, or a listing: key `*`) is
 * recorded, so the build can warn that the page written ignores it. */
export function ssgRequest(req: LoaderReq, routeId: string, path: string, record: (r: SsgRecord) => void): LoaderReq {
  const watched = (field: 'headers' | 'cookies' | 'search') => {
    const read = (key: string) => record({ kind: 'read', routeId, path, field, key })
    return new Proxy(Object.create(null) as Record<string, string>, {
      get: (t, k) => {
        if (typeof k === 'string') read(k)
        return Reflect.get(t, k)
      },
      has: (t, k) => {
        if (typeof k === 'string') read(k)
        return Reflect.has(t, k)
      },
      ownKeys: (t) => {
        read('*')
        return Reflect.ownKeys(t)
      },
      getOwnPropertyDescriptor: (t, k) => {
        if (typeof k === 'string') read(k)
        return Reflect.getOwnPropertyDescriptor(t, k)
      },
    })
  }
  return { method: 'GET', url: req.url, headers: watched('headers'), cookies: watched('cookies'), search: watched('search') }
}

export interface Handlers {
  loader(req: LoaderRequest): Promise<LoaderResponse>
  jobs(req: JobsRequest): Promise<JobsResponse>
  /** F519: the `component` call. Absent = no resolver (every ref is missing). */
  component?(req: ComponentRequest): Promise<ComponentResponse>
}

/** F519 (R5.1): a build with a `<Dynamic>` slot needs the routes entry's `components` export. The component ids that
 * hold a slot, for the boot error; empty = no slot. */
export function slotComponents(manifest: ManifestLike | undefined): string[] {
  return Object.entries(manifest?.components ?? {})
    .filter(([, c]) => c.dynamic === true)
    .map(([id]) => id)
}

/** F519 (R5.2): ask `components.resolve` for each ref (in parallel); a throw is that ref's `error`, never the call's.
 * F546 (R4, A3): then `components.render` for every asked pair whose ref is an island artifact — one this call resolved
 * as `tier: 'island'`, or one it was not asked to resolve (the server only asks renders of a warm ref that is an island)
 * — in parallel, with `{ build, page: { id, total } }`. */
export async function resolveComponents(components: RuntimeComponents | undefined, build: string, req: ComponentRequest): Promise<ComponentResponse> {
  const refs = Array.isArray(req?.refs) ? req.refs.filter((r): r is string => typeof r === 'string') : []
  const resolve = components?.resolve
  const tiers = new Map<string, unknown>()
  const results = await Promise.all(
    refs.map(async (ref): Promise<ComponentResult> => {
      if (typeof resolve !== 'function') return { ref, missing: true }
      try {
        const artifact = await resolve.call(components, ref, { build })
        if (artifact != null) tiers.set(ref, (artifact as { tier?: unknown }).tier)
        return artifact == null ? { ref, missing: true } : { ref, artifact }
      } catch (e) {
        return { ref, error: String(e) }
      }
    }),
  )
  const asked = Array.isArray(req?.renders) ? req.renders : []
  if (asked.length === 0) return { results }
  const seen = new Set<string>()
  const calls = asked.filter((r) => {
    if (typeof r?.ref !== 'string' || typeof r.key !== 'string' || seen.has(r.key)) return false
    seen.add(r.key)
    return refs.includes(r.ref) ? tiers.get(r.ref) === 'island' : true
  })
  const page = { id: typeof req.page === 'string' ? req.page : '', total: calls.length }
  const render = components?.render
  const html = await Promise.all(
    calls.map(async ({ ref, key, props }): Promise<HtmlResult> => {
      if (typeof render !== 'function') return { ref, key, html: null }
      try {
        const out = await render.call(components, ref, props && typeof props === 'object' ? props : {}, { build, page: { ...page } })
        if (out == null) return { ref, key, html: null }
        if (typeof out !== 'string') return { ref, key, error: `components.render returned ${typeof out}, not a string or null` }
        return { ref, key, html: out }
      } catch (e) {
        return { ref, key, error: String(e) }
      }
    }),
  )
  return { results, html }
}

/** `leaves` from `flattenRoutes` (ids must match the manifest's route ids); `jobs` the jobs
 * module; `manifest` supplies ssr `literals` (omit → no merge). */
export function makeHandlers(opts: {
  leaves: FlatRoute[]
  jobs: JobsModule
  manifest?: ManifestLike
  /** `jobs.js` `stores` table (R2): C3 path -> module namespace. */
  stores?: Record<string, object>
  /** Static output (R9.5): loaders see `ssgRequest`, and what a static file drops is recorded. */
  ssg?: (r: SsgRecord) => void
  /** `brust dev`: a refused `res.headers` name throws instead of being dropped with a warning (F464). */
  dev?: boolean
  /** F519: the routes entry's `components` export (its `resolve` answers the `component` call). */
  components?: RuntimeComponents
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
        const res = { headers: new LoaderHeaders(opts.dev === true) }
        // R9.5: a static file carries no headers; the build warns, naming them.
        const out = <T extends LoaderResponse>(r: T): T => {
          withHeaders(r, res.headers)
          const names = (r as { headers?: HeaderPairs }).headers?.map(([n]) => n)
          if (opts.ssg && names) opts.ssg({ kind: 'headers', routeId: req.routeId, path: req.path, names: [...new Set(names)] })
          return r
        }
        try {
          const touch = storeIdx.get(req.routeId)
          if (touch) {
            touchStores(touch, storeTable)
            // The built-in `navigation` store (design §11) paints the request's path + search on first paint.
            if (touch.includes(NAVIGATION_MODULE)) (storeTable[NAVIGATION_MODULE] as { navigation?: { hydrate(s: object): void } } | undefined)?.navigation?.hydrate({ url: req.req.url })
          }
          for (const node of leaf.chain) {
            if (!node.loader) continue
            let r: unknown
            try {
              const lreq = opts.ssg ? ssgRequest(req.req, req.routeId, req.path, opts.ssg) : req.req
              r = await node.loader({ params: req.params, path: req.path, req: lreq, res })
            } catch (e) {
              if (isHttpErrorTrigger(e)) {
                // httpError's own `headers` option adds to what the chain set. A refused name is dropped with a warning
                // in dev too: a throw here would hide the error the loader meant to send (F466).
                for (const [k, v] of Object.entries(e.headers ?? {})) {
                  if (REFUSED_HEADERS.has(k.trim().toLowerCase())) console.warn(`[brust] warning httpError headers: ${refusedMessage(k)}; dropped`)
                  else res.headers.append(k, v)
                }
                return out({ verdict: 'httpError', status: e.status, body: e.body, contentType: e.contentType } as LoaderResponse)
              }
              throw e
            }
            if (isVerdict(r)) {
              const v = out(verdictJson(r, merged))
              return 'verdict' in v && v.verdict === 'notFound' ? withStore(v) : v
            }
            if (r && typeof r === 'object') Object.assign(merged, r)
          }
          return out(withStore({ ok: true, data: merged } as LoaderResponse))
        } catch (e) {
          return { error: String(e) } as LoaderResponse
        }
      })
    },
    // One request carries every job of the page; a per-job failure keeps the other results.
    async jobs(req) {
      return { results: await Promise.all((req.jobs ?? []).map(runJob)) }
    },
    async component(req) {
      return resolveComponents(opts.components, opts.manifest?.assets?.build ?? '', req)
    },
  }
}

/** Wraps an async handler for a JSON-string boundary: parses, calls, serialises; NEVER rejects
 * (a parse error or a throwing handler resolves `{"error":…}`, like `makeDispatch`). */
export function jsonCall<Q, R>(fn: (q: Q) => Promise<R>): (json: string) => Promise<string> {
  return async (json) => {
    try {
      return toJson(await fn(JSON.parse(json)))
    } catch (e) {
      return toJson({ error: String(e) })
    }
  }
}
