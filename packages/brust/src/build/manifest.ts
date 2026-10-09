// `dist/manifest.json` (spec S6 + amendments, D6): the ONLY build→server contract. A pure
// function of the route tree and the compiler IR; every field is copied or derived as the
// consumer (`crates/brust-server/src/manifest.rs`) reads it. Where the IR cannot be expressed
// in S6 (a list or prop that is not a props path, dynamic cache tags…) this is a build error,
// never a guess.
import type { FlatRoute } from '../routes'
import type { Compiled, ComponentIR } from './compile'
import { BuildError } from './errors'

export interface JobCache {
  key: string | null
  tags: string[]
  ttl_seconds: number | null
}

export interface JobRecord {
  id: string
  kind: 'precompute' | 'ssr'
  inputs: string[]
  outputs: string[]
  target?: string
  props?: Record<string, string>
  literals?: Record<string, unknown>
  per_instance: string | null
  cache: JobCache
}

export interface ChildRecord {
  id: string
  instances: string
  props: Record<string, string>
}

export interface ComponentRecord {
  tier: 'static' | 'native' | 'react'
  template: string
  jobs: JobRecord[]
  children: ChildRecord[]
  client: string | null
  needs_worker: boolean
  use_id_slots: number
}

export interface RouteRecord {
  id: string
  pattern: string
  chain: string[]
  loaders: string[]
  cache: { ttl_seconds: number; prefix: string | null; bypass: true | string | null; tags: string[] } | null
  catch_all: boolean
}

export interface ManifestJson {
  version: 1
  routes: RouteRecord[]
  components: Record<string, ComponentRecord>
  assets: { runtime: string }
  jobs_module: string
}

// biome-ignore lint/suspicious/noExplicitAny: IR JSON (externally tagged enums)
type Json = any

/** `"Static"` | `"Native"` | `{"React":{reason, client_only}}` (`ir/mod.rs`). */
export function tierOf(ir: ComponentIR): ComponentRecord['tier'] {
  if (ir.tier === 'Static') return 'static'
  if (ir.tier === 'Native') return 'native'
  if (ir.tier && typeof ir.tier === 'object' && 'React' in ir.tier) return 'react'
  throw new BuildError('ir-tier', `${ir.id}: unexpected tier ${JSON.stringify(ir.tier)}`)
}

/** `"Precompute"` | `{"Ssr":{client_only}}` (`decls.rs`). */
function jobKind(ir: ComponentIR, j: Json, n: number): { kind: JobRecord['kind']; clientOnly: boolean } {
  if (j.kind === 'Precompute') return { kind: 'precompute', clientOnly: false }
  if (j.kind && typeof j.kind === 'object' && 'Ssr' in j.kind) return { kind: 'ssr', clientOnly: j.kind.Ssr.client_only === true }
  throw new BuildError('ir-job-kind', `${ir.id} job j${n}: unexpected kind ${JSON.stringify(j.kind)}`)
}

/** A props path printed from a `RawExpr`: `Ident{kind:Prop}` (or the identifier `root`) followed
 * by non-optional `Member`s; `null` for anything else. */
function rawPath(r: Json, root?: string): string | null {
  const k = r?.kind
  if (!k || typeof k !== 'object') return null
  if (k.Ident) {
    const { name, kind } = k.Ident
    if (root !== undefined) return name === root ? '' : null
    return kind === 'Prop' && name !== '*' ? name : null
  }
  if (k.Member && k.Member.optional === false) {
    const t = rawPath(k.Member.target, root)
    if (t === null) return null
    return t === '' ? k.Member.name : `${t}.${k.Member.name}`
  }
  return null
}

/** The `RawExpr` inside a placed `Expr` (`Raw`/`Server`); `null` otherwise. */
const placedRaw = (e: Json): Json => e?.Server ?? e?.Raw ?? null

/** Every `For` node of the template (and of JSX nested in expressions). */
function forNodes(node: Json, out: Json[] = []): Json[] {
  if (Array.isArray(node)) {
    for (const n of node) forNodes(n, out)
  } else if (node && typeof node === 'object') {
    if (node.For && typeof node.For === 'object' && 'item' in node.For && 'source' in node.For) out.push(node.For)
    for (const v of Object.values(node)) forNodes(v, out)
  }
  return out
}

/** S6 amendment: `per_instance` = the context path of the list the job runs per row of — the
 * `source` of the template `For` whose `item` is the job's `per_item`, when a plain props path. */
function perInstance(ir: ComponentIR, j: Json, n: number): string | null {
  if (j.per_item === null || j.per_item === undefined) return null
  const paths = new Set(forNodes(ir.template).filter((f) => f.item === j.per_item).map((f) => rawPath(placedRaw(f.source))))
  const [only] = paths
  if (paths.size !== 1 || only === null || only === undefined)
    throw new BuildError('per-instance-path', `${ir.id} job j${n}: list for item ${j.per_item} is not a props path`)
  return only
}

/** `ir.cache` (`decls.rs` `CacheDecl { key, tags, revalidate }`) → the S6 job cache. */
export function cacheRecord(ir: ComponentIR): JobCache {
  const c = ir.cache
  if (!c) return { key: null, tags: [], ttl_seconds: null }
  let key: string | null = null
  if (c.key) {
    const arrow = c.key.kind?.Arrow
    const body = arrow?.body?.Expr
    key = arrow && arrow.params.length === 1 && body ? rawPath(body, arrow.params[0]) : null
    if (!key) throw new BuildError('cache-key-not-a-path', `${ir.id}: cache() key must be (p) => p.<props path>`)
  }
  let tags: string[] = []
  if (c.tags) {
    // `['a']` or `(p) => ['a']`: tags are static in S6 (the server never evaluates them).
    const arrow = c.tags.kind?.Arrow
    const arr = arrow ? arrow.body?.Expr?.kind?.Array : c.tags.kind?.Array
    const lits = Array.isArray(arr) ? arr.map((e: Json) => e?.kind?.Lit?.Str) : null
    if (!lits || lits.some((t: unknown) => typeof t !== 'string'))
      throw new BuildError('cache-tags-not-static', `${ir.id}: cache() tags must be an array of string literals`)
    tags = lits
  }
  const ttl = c.revalidate ?? null
  if (ttl !== null && !(Number.isInteger(ttl) && ttl >= 0))
    throw new BuildError('cache-revalidate', `${ir.id}: cache() revalidate must be a non-negative integer (seconds)`)
  return { key, tags, ttl_seconds: ttl }
}

/** `_ssr_<childId>` / `_ssr_<childId>_<k>` → `<childId>` (a compiled component). */
function ssrTarget(ir: ComponentIR, out: string | undefined, n: number, known: (id: string) => boolean): string {
  const rest = out?.startsWith('_ssr_') ? out.slice('_ssr_'.length) : undefined
  const id = rest === undefined ? undefined : known(rest) ? rest : rest.replace(/_\d+$/, '')
  if (id === undefined || !known(id))
    throw new BuildError('ssr-target', `${ir.id} job j${n}: output ${out} names no compiled react component`)
  return id
}

/** `jobs[]` of one component, ids `j<IR index>`. A `client_only` ssr job is not written (S6
 * amendment); its target is returned in `clientOnly` for the parent's `children[]`. */
export function jobRecords(c: Compiled, known: (id: string) => boolean): { jobs: JobRecord[]; clientOnly: string[] } {
  const { ir } = c
  const cache = cacheRecord(ir)
  const jobs: JobRecord[] = []
  const clientOnly: string[] = []
  ir.jobs.forEach((j: Json, n: number) => {
    const { kind, clientOnly: co } = jobKind(ir, j, n)
    const id = `j${n}`
    if (kind === 'ssr') {
      const target = ssrTarget(ir, j.outputs?.[0], n, (t) => t === ir.id || known(t))
      if (co) {
        if (target !== ir.id && !clientOnly.includes(target)) clientOnly.push(target)
        return
      }
      const rec: JobRecord = { id, kind, inputs: [...j.inputs], outputs: [...j.outputs], target, per_instance: perInstance(ir, j, n), cache }
      if (j.props) {
        const props: Record<string, string> = {}
        for (const [name, path] of Object.entries(j.props as Record<string, string | null>)) {
          if (path === null) throw new BuildError('ssr-prop-not-a-path', `${ir.id} job j${n}: prop ${name} is not a props path`)
          props[name] = path
        }
        rec.props = props
      }
      if (j.literals && Object.keys(j.literals).length > 0) rec.literals = { ...j.literals }
      jobs.push(rec)
      return
    }
    jobs.push({ id, kind, inputs: [...j.inputs], outputs: [...j.outputs], per_instance: perInstance(ir, j, n), cache })
  })
  return { jobs, clientOnly }
}

/** `children[]` from `ir.instances` in compiler order (`k` = ordinal per child id, derived by
 * both sides), then one static entry per `client_only` react child (asset injection only). */
export function childRecords(c: Compiled, clientOnly: string[] = []): ChildRecord[] {
  const { ir } = c
  const out: ChildRecord[] = ir.instances.map((inst) => {
    if (inst.loops.length > 1)
      throw new BuildError('nested-instance', `${ir.id}: child ${inst.child_id} sits in nested lists (M3)`)
    const list = inst.loops[0]
    if (list === null)
      throw new BuildError('instance-list-path', `${ir.id}: child ${inst.child_id} sits in a list that is not a props path`)
    const props: Record<string, string> = {}
    for (const [name, path] of Object.entries(inst.props)) {
      if (path === null)
        throw new BuildError('instance-prop-path', `${ir.id}: child ${inst.child_id} prop ${name} is not a props path`)
      props[name] = path
    }
    return { id: inst.child_id, instances: list === undefined ? 'static' : `per-row:${list}`, props }
  })
  for (const id of clientOnly) out.push({ id, instances: 'static', props: {} })
  return out
}

export function writeManifest(opts: {
  leaves: FlatRoute[]
  routeComponent: Map<string, string>
  compiled: Map<string, Compiled>
  runtime: string
  /** component id → `client/<file>` (client chunk or react island chunk). */
  chunks: Map<string, string>
}): ManifestJson {
  const { compiled } = opts
  const known = (id: string) => compiled.has(id)
  const components: Record<string, ComponentRecord> = {}
  for (const c of [...compiled.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const { jobs, clientOnly } = jobRecords(c, known)
    components[c.id] = {
      tier: tierOf(c.ir),
      template: `jinja/${c.id}.jinja`,
      jobs,
      children: childRecords(c, clientOnly),
      client: opts.chunks.get(c.id) ?? null,
      needs_worker: jobs.length > 0,
      use_id_slots: c.ir.use_id_slots ?? 0,
    }
  }
  const routes: RouteRecord[] = opts.leaves.map((l) => {
    // A node without a Component (a pure path/loader group) renders nothing: not a chain entry.
    const chain = l.chainIds.flatMap((rid, i) => {
      if (!l.chain[i]!.Component) return []
      const cid = opts.routeComponent.get(rid)
      if (!cid) throw new BuildError('component-source', `route ${rid} has no compiled Component`)
      return [cid]
    })
    const leaf = l.chain[l.chain.length - 1]!
    const c = leaf.cache
    return {
      id: l.id,
      pattern: l.pattern,
      chain,
      loaders: l.chain.flatMap((node, i) => (node.loader ? [l.chainIds[i]!] : [])),
      cache: c ? { ttl_seconds: c.ttl_seconds, prefix: c.prefix ?? null, bypass: c.bypass ?? null, tags: c.tags ?? [] } : null,
      catch_all: l.catchAll,
    }
  })
  linkNativeChunks(routes, compiled, components)
  return { version: 1, routes, components, assets: { runtime: opts.runtime }, jobs_module: 'jobs.js' }
}

/** S6 amendment (F66): the server's asset injection walks only each chain component's direct
 * `children[]`, and an inlined native child with a client chunk but no job and no `useId` has no
 * `instances[]` record. So every chain component gets one static entry `{ id, instances:
 * "static", props: {} }` per chunk-bearing non-react descendant reached through the IR's
 * `children[]` (transitively; react children render their own subtree), in depth-first IR order,
 * once, and only when that id has no record there yet. Other records are left as they are. */
function linkNativeChunks(routes: RouteRecord[], compiled: Map<string, Compiled>, components: Record<string, ComponentRecord>) {
  const chainIds = new Set(routes.flatMap((r) => r.chain))
  for (const root of chainIds) {
    const rec = components[root]!
    const linked = new Set(rec.children.map((ch) => ch.id))
    const seen = new Set([root])
    const walk = (id: string) => {
      for (const ref of compiled.get(id)?.ir.children ?? []) {
        const cid: string | null = ref.id
        if (!cid || seen.has(cid) || !compiled.has(cid)) continue
        seen.add(cid)
        const child = components[cid]!
        if (child.tier === 'react') continue
        if (child.client !== null && !linked.has(cid)) {
          // The compiler rejects a job/useId child below the first level, and a direct one has
          // an instances[] record: a static entry with no props must never drive a job or slot.
          if (child.jobs.length > 0 || child.use_id_slots > 0)
            throw new BuildError('child-chunk-link', `${root}: ${cid} has a job or useId but no instances[] record`)
          linked.add(cid)
          rec.children.push({ id: cid, instances: 'static', props: {} })
        }
        walk(cid)
      }
    }
    walk(root)
  }
}
