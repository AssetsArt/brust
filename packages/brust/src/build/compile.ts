// Per-file compile (plan T5, contract 9): every route Component goes through
// `compileTree` (analysis + lowering of its whole tree). `Err` = build error; fallback and
// warning diagnostics are logged; `outlet-outside-layout` is raised here (contract 5).
// A component several trees reach keeps one compile, chosen by role, not by route order (F75).
import { realpathSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { type CompiledComponent, type CompiledTree, compileTree, scanLoadWrites } from '../../native/index.js'
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
    /** R34.96: the job modules fused into the child's job, which it imports (`FusedEvalJob`). */
    fused?: { child_id: string; stubs?: { source: string; code: string }[] }[]
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
  /** A component compiled from a package source and written in app code as a package import (F188): the published
   * export a React island or revive hook imports instead of the source. */
  dist?: { source: string; export: string; member?: string[] }
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
  /** F362 PR2: `clientJs` importing every imported list as written; the build uses it when a module in
   * `projectedModules` is still in the client graph through another importer (`bundle.ts` `buildClientChunks`). */
  clientJsWhole?: string
  /** F362 PR2: data modules (app-root-relative) whose imported list `clientJs` declares projected instead of importing. */
  projectedModules?: string[]
  /** Modules the chunk imports that other chunks share (R34.124): `<name>.js` beside it. */
  clientModules?: { name: string; code: string }[]
  /** The compiler's diagnostics for this component (`dev.json`, L14). */
  diagnostics?: { class: string; rule: string; message: string; line: number; col: number; remediation: string; file?: string | null }[]
}

type Diag = NonNullable<CompiledTree['error']>
/** `file:line:col`; a finding raised in another module than the component it is reported on names that module (F395). */
const where = (file: string, d: Diag) => `${d.file ?? file}:${d.line}:${d.col}`

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

/**
 * F230 (closes F219): scans the app's modules once for writes into another app module's exports (`LABELS.a = …`,
 * `list.push(…)` through an import) and returns the JSON every `compileTree` of the build reads: a component whose
 * compiled code reads such an export falls back to React (`module-written`). `modules` are absolute paths.
 */
export function scanAppWrites(appRoot: string, modules: string[], log: (s: string) => void, sourceRoots: string[] = []): string {
  // Keyed as `compileApp` names a file to the compiler (relative to `appRoot`), plus the real-path spelling (as
  // `routeRoots`), so an import resolves to the same key either way.
  const real = realpathSync(appRoot)
  const toKey = (base: string, f: string) => relative(base, f).split(sep).join('/')
  // F276: a module under a `[build] source_roots` directory (`../shared/x.ts`) is scanned too; any other `..` key is not.
  const inSourceRoot = (k: string) => sourceRoots.some((r) => k.startsWith(`${r}/`))
  const rel = [...new Set(modules.flatMap((f) => [toKey(appRoot, f), toKey(real, realpathSync(f))]))].filter((k) => !k.startsWith('..') || inSourceRoot(k)).sort()
  const { aliases } = readPathAliases(appRoot)
  const t0 = performance.now()
  const json = scanLoadWrites(appRoot, rel, aliases.length > 0 ? JSON.stringify(aliases) : undefined, sourceRoots.length > 0 ? sourceRoots : undefined)
  const ms = performance.now() - t0
  if (process.env.BRUST_BUILD_TIMINGS) log(`[brust] scan load-time writes: ${rel.length} modules in ${ms.toFixed(1)} ms`)
  return json
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
  /** F256: `[build] source_roots`, normalised and relative to the app root (`../shared`). */
  sourceRoots?: string[]
  /** F230: `scanAppWrites`'s result; absent = no module is refused for a load-time write. */
  loadWrites?: string
}): { compiled: Map<string, Compiled>; routeComponent: Map<string, string> } {
  const { appRoot, leaves, componentFile } = opts
  const iconSvgsJson = opts.iconsFinal ? JSON.stringify({ final: true, svgs: opts.iconSvgs ?? {} }) : undefined
  const slotValuesJson = opts.slotValues && Object.keys(opts.slotValues).length > 0 ? JSON.stringify(opts.slotValues) : undefined
  const packagesJson = opts.packages ? JSON.stringify(opts.packages) : undefined
  const sourceRoots = opts.sourceRoots && opts.sourceRoots.length > 0 ? opts.sourceRoots : undefined
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
      const tree = compileTree(rel, appRoot, opts.runtimeImport, opts.serverOnly, slotValuesJson, cssModules, iconSvgsJson, routeRoots, pathAliasesJson, packagesJson, sourceRoots, opts.loadWrites)
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
      clientJsWhole: c.clientJsWhole ?? undefined,
      projectedModules: c.projectedModules?.length ? c.projectedModules : undefined,
      clientModules: c.clientModules?.length ? c.clientModules : undefined,
      diagnostics: c.diagnostics.map((d) => ({ class: d.class, rule: d.rule, message: d.message, line: d.line, col: d.col, remediation: d.remediation, file: d.file })),
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
  checkLayoutContexts(leaves, compiled, routeComponent)
  return { compiled, routeComponent }
}

/**
 * F437: a component the compiler refused to lower because it reads a context imported from another module
 * (`useContext(Ctx)`, `ir.foreign_ctx_reads`) ships as a React island, and an island's SSR and `hydrateRoot` render it
 * alone, without the Providers a layout above its route renders: it would paint the `createContext` default where React
 * paints the layout's value. Refused here, by name, conservatively: a Provider anywhere in the layout's compiled tree
 * (`ir.provides` of the layout or of any component it renders) declared in a file counts as providing every context that
 * file declares, so a read of ANY binding imported from that file is refused (an alias, `export { A as B }`, a re-export of
 * the file's own context cannot slip by). A context nobody provides still reads its default, which is React's own answer.
 * Native resolution of an imported context is F439.
 */
function checkLayoutContexts(leaves: FlatRoute[], compiled: Map<string, Compiled>, routeComponent: Map<string, string>): void {
  const real = (f: string) => {
    try {
      return realpathSync(f)
    } catch {
      return f
    }
  }
  for (const leaf of leaves) {
    const provided: { file: string; layout: string }[] = []
    for (const id of leaf.chainIds) {
      const rootId = routeComponent.get(id)
      const root = rootId === undefined ? undefined : compiled.get(rootId)
      if (!root) continue
      // The tree of this route's component: the layouts above it provided `provided` so far.
      if (provided.length > 0) {
        const stack = [root.id]
        const done = new Set<string>()
        while (stack.length > 0) {
          const c = compiled.get(stack.pop()!)
          if (!c || done.has(c.id)) continue
          done.add(c.id)
          for (const [src, name] of (c.ir.foreign_ctx_reads ?? []) as [string, string][]) {
            let from: string
            try {
              from = real(Bun.resolveSync(src, dirname(c.file)))
            } catch {
              continue
            }
            const hit = provided.find((p) => p.file === from)
            if (hit)
              throw new BuildError(
                'island-layout-context',
                `${c.ir.source} reads the context \`${name}\` (useContext) that the layout ${hit.layout} provides, but this component renders as a React island, and an island does not see its layout's Provider (it would paint the createContext default). Workaround: pass the value to the page through its loader (a prop), or render the Provider inside this component's own tree. Native resolution of an imported context is F439.`,
              )
          }
          for (const ch of (c.ir.children ?? []) as { id: string | null }[]) if (ch.id) stack.push(ch.id)
        }
      }
      // Every Provider the layout's compiled tree renders (the layout itself or a component it calls), by declaring file.
      const stack = [root.id]
      const done = new Set<string>()
      while (stack.length > 0) {
        const c = compiled.get(stack.pop()!)
        if (!c || done.has(c.id)) continue
        done.add(c.id)
        if ((c.ir.provides ?? []).length > 0) provided.push({ file: real(c.file), layout: root.ir.source })
        for (const ch of (c.ir.children ?? []) as { id: string | null }[]) if (ch.id) stack.push(ch.id)
      }
    }
  }
}
