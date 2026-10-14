// Route scan (plan T5, gaps L7): import the route entry, then walk its static import graph (inside the app root,
// outside node_modules) and map every Component to the `.tsx` file it is the default export of. The compiler only ever sees files, never functions.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { BrustRouteError, type Route } from '../routes'
import { BuildError } from './errors'
import { installServerOnlyRuntime } from './server-only'

/** `componentIssue` explains a Component the walk saw but could not map (named-only, outside the root, in node_modules). */
export async function scanRoutes(
  entryFile: string,
  appRoot?: string,
): Promise<{ routes: Route[]; componentFile: Map<Function, string>; componentIssue: Map<Function, string> }> {
  // biome-ignore lint/suspicious/noExplicitAny: an arbitrary user module
  let mod: any
  installServerOnlyRuntime() // `server-only` resolves to an empty module: a loader may import server-only code
  try {
    mod = await import(entryFile)
  } catch (e) {
    // defineRoutes validation (unsupported field, bad cache, …) throws at import time.
    if (e instanceof BrustRouteError) throw new BuildError(e.rule, e.message)
    throw e
  }
  const routes = mod.routes ?? mod.default
  if (!Array.isArray(routes))
    throw new BuildError('route-entry', `${entryFile} exports neither \`routes\` nor a default route array`)

  const componentFile = new Map<Function, string>()
  const componentIssue = new Map<Function, string>()
  const root = realpathSync(resolve(appRoot ?? dirname(entryFile)))
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })
  const inRoot = (f: string) => f.startsWith(root + sep) && !f.split(sep).includes('node_modules')
  const visited = new Set<string>()
  // Post-order: a file's imports are mapped before the file itself, and the first file to claim a function
  // keeps it, so the module that defines a Component beats a barrel that re-exports it.
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return
    visited.add(file)
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      return
    }
    const loader = file.endsWith('.tsx') ? transpiler : file.endsWith('.ts') ? new Bun.Transpiler({ loader: 'ts' }) : null
    if (!loader) return
    const deps: string[] = []
    // Only static imports are followed: a dynamic import() is not part of the route table's static graph.
    for (const imp of loader.scanImports(src)) {
      if (imp.kind !== 'import-statement') continue
      let dep: string
      try {
        dep = Bun.resolveSync(imp.path, dirname(file))
      } catch {
        continue // a bare specifier that does not resolve; a route using it fails in compileApp
      }
      if (!dep.endsWith('.tsx') && !dep.endsWith('.ts')) continue
      if (inRoot(dep)) deps.push(dep)
      else if (dep.endsWith('.tsx')) await note(dep, dep.split(sep).includes('node_modules') ? 'in node_modules' : `outside the app root ${root}`)
    }
    for (const dep of deps) await visit(dep)
    if (!file.endsWith('.tsx')) return
    const m = await import(file)
    for (const [name, v] of Object.entries(m)) {
      if (typeof v !== 'function') continue
      if (name === 'default') {
        if (!componentFile.has(v)) componentFile.set(v, file)
      } else if (!componentIssue.has(v)) {
        componentIssue.set(v, `${v.name || name} is only a named export of ${file} (export ${name}): export it as default`)
      }
    }
  }
  const note = async (file: string, why: string) => {
    try {
      const def = (await import(file)).default
      if (typeof def === 'function' && !componentIssue.has(def)) componentIssue.set(def, `${def.name || '(anonymous)'} lives in ${file}, which is ${why}`)
    } catch {}
  }
  await visit(entryFile)
  // A function reachable as a default somewhere is fine; only an unmapped one keeps its explanation.
  for (const f of componentFile.keys()) componentIssue.delete(f)
  return { routes, componentFile, componentIssue }
}
