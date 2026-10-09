// Per-file compile (plan T5, contract 9): every route Component goes through
// `compileTree` (analysis + lowering of its whole tree). `Err` = build error; fallback and
// warning diagnostics are logged; `outlet-outside-layout` is raised here (contract 5).
import { relative } from 'node:path'
import { type CompiledTree, compileTree } from '../../native/index.js'
import type { FlatRoute, Route } from '../routes'
import { BuildError } from './errors'

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
  instances: { child_id: string; k: number; loops: (string | null)[]; props: Record<string, string | null> }[]
  use_id_slots: number
  uses_outlet: boolean
  needs_worker: boolean
}

export interface Compiled {
  id: string
  /** Absolute path of the component's source file. */
  file: string
  ir: ComponentIR
  jinja: string
  serverTs?: string
  clientJs?: string
}

type Diag = NonNullable<CompiledTree['error']>
const where = (file: string, d: Diag) => `${file}:${d.line}:${d.col}`

export function compileApp(opts: {
  appRoot: string
  leaves: FlatRoute[]
  componentFile: Map<Function, string>
  runtimeImport: string
  serverOnly: string[]
  log: (s: string) => void
}): { compiled: Map<string, Compiled>; routeComponent: Map<string, string> } {
  const { appRoot, leaves, componentFile } = opts
  const compiled = new Map<string, Compiled>()
  const rootIdOfFile = new Map<string, string>()
  const routeComponent = new Map<string, string>()
  // Route nodes with a Component, by id (a layout appears in several chains: once is enough).
  const nodes = new Map<string, Route>()
  for (const l of leaves) l.chain.forEach((r, i) => r.Component && nodes.set(l.chainIds[i]!, r))

  for (const [routeId, route] of nodes) {
    const file = componentFile.get(route.Component!)
    if (!file)
      throw new BuildError(
        'component-source',
        `${route.Component!.name || '(anonymous)'} is not a default import of a .tsx file (route ${routeId})`,
      )
    let rootId = rootIdOfFile.get(file)
    if (!rootId) {
      const rel = relative(appRoot, file)
      const tree = compileTree(rel, appRoot, opts.runtimeImport, opts.serverOnly)
      if (tree.error) throw new BuildError(tree.error.rule, `${where(rel, tree.error)} ${tree.error.message}`)
      for (const c of tree.components) {
        // A lowering Error that came back as a diagnostic is a build error too (contract 9).
        const err = c.diagnostics.find((d) => d.class === 'error')
        if (err) throw new BuildError(err.rule, `${where(c.source, err)} ${err.message}`)
        if (compiled.has(c.id)) continue // a child reached from several trees
        for (const d of c.diagnostics)
          if (d.class === 'fallback' || d.class === 'warning') opts.log(`warning ${d.rule} ${where(c.source, d)} ${d.message}`)
        const ir = JSON.parse(c.ir) as ComponentIR
        ir.use_id_slots ??= 0
        ir.uses_outlet ??= false
        ir.instances ??= []
        compiled.set(c.id, {
          id: c.id,
          file: `${appRoot}/${c.source}`,
          ir,
          jinja: c.jinja,
          serverTs: c.serverTs,
          clientJs: c.clientJs,
        })
      }
      rootId = tree.components[0]!.id // the root comes first (pipeline.rs)
      rootIdOfFile.set(file, rootId)
    }
    routeComponent.set(routeId, rootId)
    if (compiled.get(rootId)!.ir.uses_outlet && !route.children)
      throw new BuildError(
        'outlet-outside-layout',
        `${route.Component!.name || rootId} renders <Outlet/> but route ${routeId} has no children`,
      )
  }
  return { compiled, routeComponent }
}
