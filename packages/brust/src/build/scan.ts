// Route scan (plan T5): import the route entry, then map every route Component to the `.tsx`
// file it is the default export of. The compiler only ever sees files, never functions.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BrustRouteError, type Route } from '../routes'
import { BuildError } from './errors'

const DEFAULT_IMPORT = /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/gm

export async function scanRoutes(entryFile: string): Promise<{ routes: Route[]; componentFile: Map<Function, string> }> {
  // biome-ignore lint/suspicious/noExplicitAny: an arbitrary user module
  let mod: any
  try {
    mod = await import(entryFile)
  } catch (e) {
    // defineRoutes validation (unsupported field, bad cache, …) throws at import time.
    if (e instanceof BrustRouteError) throw new BuildError('route-config', e.message)
    throw e
  }
  const routes = mod.routes ?? mod.default
  if (!Array.isArray(routes))
    throw new BuildError('route-entry', `${entryFile} exports neither \`routes\` nor a default route array`)

  const src = readFileSync(entryFile, 'utf8')
  const real = new Set(new Bun.Transpiler({ loader: 'tsx' }).scanImports(src).map((i) => i.path))
  const componentFile = new Map<Function, string>()
  for (const m of src.matchAll(DEFAULT_IMPORT)) {
    const spec = m[2]!
    if (!real.has(spec)) continue // inside a comment or string: not an import
    let file: string
    try {
      file = Bun.resolveSync(spec, dirname(entryFile))
    } catch {
      continue // a bare specifier the route file never uses as a Component; checked below
    }
    if (!file.endsWith('.tsx')) continue // not a component source; a route using it fails in compileApp
    const def = (await import(file)).default
    // Bun's module cache: the same function object the routes tree holds.
    if (typeof def === 'function') componentFile.set(def, file)
  }
  return { routes, componentFile }
}
