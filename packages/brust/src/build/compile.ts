// Per-file compile (plan T5, contract 9): every route Component goes through
// `compileTree` (analysis + lowering of its whole tree). `Err` = build error; fallback and
// warning diagnostics are logged; `outlet-outside-layout` is raised here (contract 5).
// A component several trees reach keeps one compile, chosen by role, not by route order (F75).
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { type CompiledComponent, type CompiledTree, compileTree } from '../../native/index.js'
import type { FlatRoute, Route } from '../routes'
import { BuildError } from './errors'
import { checkAliasAgreement, readPathAliases } from './tsconfig-paths'
import type { PackageSources } from './pkg-src'

/** `ComponentIR` as the compiler serialises it (snake_case), with the fields that are absent
 * when default (`ir/mod.rs`) normalised. The build reads it; it never rewrites it. */
// biome-ignore lint/suspicious/noExplicitAny: IR JSON, read structurally by the manifest writer
export type ComponentIR = Record<string, any> & {
  id: string
  source: string
  // biome-ignore lint/suspicious/noExplicitAny: externally tagged enum
  tier: any
  // biome-ignore lint/suspicious/noExplicitAny: IR JSON
  jobs: any[]
  instances: {
    child_id: string
    k: number
    loops: (string | null)[]
    props: Record<string, string | null>
    literals?: Record<string, unknown>
    exprs?: Record<string, string>
    /** F142 R34.43: the rows of a constant enclosing list (`loops` is then `[null]`). */
    rows_literal?: unknown[]
  }[]
  /** F149: inlined instances whose child job the build may run once (`decls.rs` `BuildEvalInstance`). */
  build_eval_instances?: {
    key: string
    child_id: string
    k: number
    inputs: Record<string, unknown>
    outputs: string[]
    stubs?: { source: string; code: string }[]
    line: number
    col: number
  }[]
  use_id_slots: number
  uses_outlet: boolean
  needs_worker: boolean
  /** `useStore(handle)` bindings (`decls.rs` `StoreUse`); `resolved` = `StoreRef`, `null` when
   * unresolved (the component falls back). `module` is root-relative (C3). */
  stores?: { handle: string; resolved: { name: string; module: string } | null }[]
  /** A package export rendered as a React island (L22): `source` is then not a file. */
  external?: { source: string; export: string; member?: string[] }
  /** The binding a React island imports this component by from `source` (absent: the default export). */
  export?: string
  /** Child components; `nested` is set when this file passes lowered JSX children to that child, an island (shadcn S1). */
  children?: { id: string | null; nested?: string[]; x?: string[]; holes?: string[]; [field: string]: unknown }[]
}

export interface Compiled {
  id: string
  /** Absolute path of the component's source file. */
  file: string
  ir: ComponentIR
  jinja: string
  serverTs?: string
  /** Build-time evaluation module (L2): one thunk per `ir.build_eval` slot. */
  evalTs?: string
  clientJs?: string
  /** The compiler's diagnostics for this component (`dev.json`, L14). */
  diagnostics?: { class: string; rule: string; message: string; line: number; col: number; remediation: string }[]
}

type Diag = NonNullable<CompiledTree['error']>
const where = (file: string, d: Diag) => `${file}:${d.line}:${d.col}`

/** How a tree reached a component (F75). A route root's props are fixed, so after F70 it may drop
 * the row links a parent elsewhere drives; a child that no parent in its tree links may have no
 * chunk. A higher role's artifacts are a superset of a lower one's: the build keeps the highest. */
export const ROLE = { root: 0, child: 1, chunkChild: 2 } as const
export type Role = (typeof ROLE)[keyof typeof ROLE]

/** One compile of a component: its role, the tree (route-root file, app-relative) that made it. */
export interface Seen {
  role: Role
  tree: string
  c: CompiledComponent
}

export const roleOf = (c: CompiledComponent, first: boolean): Role =>
  first ? ROLE.root : c.clientJs === undefined ? ROLE.child : ROLE.chunkChild

/** Whether `next` (same id, a later tree) replaces `kept`. A child's IR depends only on its own
 * subtree, so two child compiles must agree on `ir` and `serverTs`, and two of the same role on
 * everything; anything else is `component-compile-divergent` (a compiler bug, never route order). */
export function replaces(kept: Seen, next: Seen): boolean {
  if (kept.role !== ROLE.root && next.role !== ROLE.root) {
    const [k, n] = [kept.c, next.c]
    const same =
      k.ir === n.ir &&
      k.serverTs === n.serverTs &&
      (kept.role !== next.role || (k.jinja === n.jinja && k.clientJs === n.clientJs))
    if (!same)
      throw new BuildError(
        'component-compile-divergent',
        `${n.id} (${n.source}) compiles differently as a child in ${kept.tree} and in ${next.tree}`,
      )
  }
  return next.role > kept.role
}

export function compileApp(opts: {
  appRoot: string
  leaves: FlatRoute[]
  componentFile: Map<Function, string>
  /** Why a Component the scan saw has no file (named export only, outside the root); optional. */
  componentIssue?: Map<Function, string>
  runtimeImport: string
  serverOnly: string[]
  /** L20: every CSS Module's class map by absolute source path; `styles.x` folds to the literal class. */
  cssMaps?: Map<string, Record<string, string>>
  log: (s: string) => void
  /** SVG markup the build rendered for lucide icon requests (L23), by `ir.icon_requests[].key`. */
  iconSvgs?: Record<string, { svg: string; base: string }>
  /** The compile after icons were rendered (even if none could be): icons still components are judged as islands. */
  iconsFinal?: boolean
  /** Values the build computed for `ir.build_eval` slots, by key (L2): the slots become literals. */
  slotValues?: Record<string, unknown>
  /** F153c: the package sources this build wrote (`pkg-src.ts`); absent = package imports are islands. */
  packages?: PackageSources
}): { compiled: Map<string, Compiled>; routeComponent: Map<string, string> } {
  const { appRoot, leaves, componentFile } = opts
  const iconSvgsJson = opts.iconsFinal ? JSON.stringify({ final: true, svgs: opts.iconSvgs ?? {} }) : undefined
  const slotValuesJson = opts.slotValues && Object.keys(opts.slotValues).length > 0 ? JSON.stringify(opts.slotValues) : undefined
  const packagesJson = opts.packages ? JSON.stringify(opts.packages) : undefined
  // The Rust side keys each map by its path relative to the app root (`/`-separated), like an import resolves.
  const { aliases, notes } = readPathAliases(appRoot)
  for (const n of notes) opts.log(`warning tsconfig-paths ${n}`)
  const pathAliasesJson = aliases.length > 0 ? JSON.stringify(aliases) : undefined
  const cssModules = Object.fromEntries([...(opts.cssMaps ?? [])].map(([abs, map]) => [relative(realpathSync(appRoot), abs).split(sep).join('/'), map]))
  const seen = new Map<string, Seen>()
  const rootIdOfFile = new Map<string, string>()
  const routeComponent = new Map<string, string>()
  // Route nodes with a Component, by id (a layout appears in several chains: once is enough).
  const nodes = new Map<string, Route>()
  for (const l of leaves) l.chain.forEach((r, i) => r.Component && nodes.set(l.chainIds[i]!, r))

  // F158 (R34.69): the route components (pages and layouts) take request data as props, so the compiler never hands
  // them lowered JSX from a caller. Keyed like an import resolves: relative to the app root, `/`-separated.
  const rootRel = (f: string) => relative(appRoot, f).split(sep).join('/')
  const routeRoots = [...new Set([...nodes.values()].flatMap((r) => componentFile.get(r.Component!) ?? []).flatMap((f) => [rootRel(f), relative(realpathSync(appRoot), realpathSync(f)).split(sep).join('/')]))]

  for (const [routeId, route] of nodes) {
    const file = componentFile.get(route.Component!)
    if (!file)
      throw new BuildError(
        'component-source',
        `${opts.componentIssue?.get(route.Component!) ?? `${route.Component!.name || '(anonymous)'} is not the default export of a .tsx file in the import graph`} (route ${routeId})`,
      )
    let rootId = rootIdOfFile.get(file)
    if (!rootId) {
      const rel = relative(appRoot, file)
      const tree = compileTree(rel, appRoot, opts.runtimeImport, opts.serverOnly, slotValuesJson, cssModules, iconSvgsJson, routeRoots, pathAliasesJson, packagesJson)
      if (tree.error) throw new BuildError(tree.error.rule, `${where(rel, tree.error)} ${tree.error.message}`)
      for (const [i, c] of tree.components.entries()) {
        // A lowering Error that came back as a diagnostic is a build error too (contract 9).
        const err = c.diagnostics.find((d) => d.class === 'error')
        if (err) throw new BuildError(err.rule, `${where(c.source, err)} ${err.message}`)
        const next: Seen = { role: roleOf(c, i === 0), tree: rel, c }
        const kept = seen.get(c.id) // a child reached from several trees, or a root another tree reaches
        if (!kept || replaces(kept, next)) seen.set(c.id, next)
      }
      rootId = tree.components[0]!.id // the root comes first (pipeline.rs)
      rootIdOfFile.set(file, rootId)
    }
    routeComponent.set(routeId, rootId)
  }

  // Every tree is in: the kept compile is final. Map order = first sight (`set` keeps a key's place).
  const compiled = new Map<string, Compiled>()
  for (const { c } of seen.values()) {
    for (const d of c.diagnostics)
      if (d.class === 'fallback' || d.class === 'warning') opts.log(`warning ${d.rule} ${where(c.source, d)} ${d.message}`)
    const ir = JSON.parse(c.ir) as ComponentIR
    if (ir.alias_imports?.length) checkAliasAgreement(appRoot, ir.alias_imports)
    ir.use_id_slots ??= 0
    ir.uses_outlet ??= false
    ir.instances ??= []
    ir.stores ??= []
    compiled.set(c.id, {
      id: c.id,
      file: `${appRoot}/${c.source}`,
      ir,
      jinja: c.jinja,
      serverTs: c.serverTs,
      evalTs: c.evalTs,
      clientJs: c.clientJs,
      diagnostics: c.diagnostics.map((d) => ({ class: d.class, rule: d.rule, message: d.message, line: d.line, col: d.col, remediation: d.remediation })),
    })
  }
  // A package export has no file of its own: bare imports in its island entries resolve from a
  // component that uses it (the first one in build order).
  for (const c of compiled.values()) {
    if (!c.ir.external) continue
    const user = [...compiled.values()].find((p) => !p.ir.external && (p.ir.children ?? []).some((ref: { id: string | null }) => ref.id === c.id))
    c.file = user?.file ?? c.file
  }
  for (const [routeId, route] of nodes) {
    const rootId = routeComponent.get(routeId)!
    if (compiled.get(rootId)!.ir.uses_outlet && !route.children)
      throw new BuildError(
        'outlet-outside-layout',
        `${route.Component!.name || rootId} renders <Outlet/> but route ${routeId} has no children`,
      )
  }
  return { compiled, routeComponent }
}
