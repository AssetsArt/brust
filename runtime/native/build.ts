import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { scanImports } from '../cli/native-routes-emit.ts'

const BEHAVIOR_RE = /export\s+const\s+behavior\b/

/** camelCase a component basename: lowercase the first character only. */
function registerName(sourcePath: string): string {
  const base = basename(sourcePath, extname(sourcePath))
  return base.length > 0 ? base[0]!.toLowerCase() + base.slice(1) : base
}

/** BFS the local import graph from the routes entry; return registerName →
 * absolute sourcePath for every file that has `export const behavior`. Throws on
 * two distinct files deriving the same register name. */
export function scanDirectiveComponents(routesEntryFile: string): Map<string, string> {
  const found = new Map<string, string>()
  const visited = new Set<string>()
  const queue: string[] = [...scanImports(routesEntryFile).values()]
  while (queue.length > 0) {
    const filePath = queue.shift() as string
    if (visited.has(filePath)) continue
    visited.add(filePath)
    let src = ''
    try {
      src = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    for (const dep of scanImports(filePath).values()) {
      if (!visited.has(dep)) queue.push(dep)
    }
    if (BEHAVIOR_RE.test(src)) {
      const name = registerName(filePath)
      const existing = found.get(name)
      if (existing && existing !== filePath) {
        throw new Error(
          `directive component name "${name}" derives from two files (${existing} and ${filePath}); component basenames must be app-unique`,
        )
      }
      found.set(name, filePath)
    }
  }
  return found
}

export interface BuildDirectivesResult {
  outDir: string
  count: number
}

// React-presence markers in a bundled output. `external: []` inlines react, so we
// match React's stable runtime strings rather than a bare `react` import specifier.
// `__SECRET_INTERNALS` is React 18's name; `__CLIENT_INTERNALS` is React 19's — both
// kept so the guard fires regardless of the react major. `react.dev` is the error-URL
// baked into react's dev/prod runtime; `useSyncExternalStore` is the hook `useStore`
// pulls. `createRoot`/`hydrateRoot`/`react-dom` catch a react-dom (client render) leak.
const REACT_MARKER_RE =
  /createRoot|hydrateRoot|react-dom|__SECRET_INTERNALS|__CLIENT_INTERNALS|react\.dev|useSyncExternalStore/

/** Generate a registration entry, bundle it self-contained to
 * `<outDir>/_directives.js`, and assert no React leaked in. */
export async function buildDirectives(
  components: Map<string, string>,
  options: { outDir: string },
): Promise<BuildDirectivesResult> {
  const outDir = isAbsolute(options.outDir)
    ? options.outDir
    : resolve(process.cwd(), options.outDir)
  mkdirSync(outDir, { recursive: true })
  if (components.size === 0) return { outDir, count: 0 }

  // Generate the entry: import each behavior, register it, then start().
  const lines = ["import { register, start } from 'brustjs/native'"]
  let i = 0
  for (const [name, src] of components) {
    lines.push(`import { behavior as b${i} } from ${JSON.stringify(src)}`)
    lines.push(`register(${JSON.stringify(name)}, b${i})`)
    i++
  }
  lines.push('start()')
  const entryPath = resolve(outDir, '_directives.entry.ts')
  writeFileSync(entryPath, `${lines.join('\n')}\n`)

  try {
    const result = await Bun.build({
      entrypoints: [entryPath],
      outdir: outDir,
      naming: '_directives.js',
      format: 'esm',
      target: 'browser',
      external: [], // self-contained — bundle store + treaty; react is tree-shaken out
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!result.success) {
      const messages = result.logs.map((l) => String(l)).join('\n')
      throw new Error(`buildDirectives: Bun.build failed:\n${messages}`)
    }
  } finally {
    rmSync(entryPath, { force: true })
  }

  const out = readFileSync(resolve(outDir, '_directives.js'), 'utf8')
  if (REACT_MARKER_RE.test(out)) {
    throw new Error(
      'buildDirectives: React leaked into _directives.js — a behavior imported a ' +
        'react-pulling symbol (e.g. useStore from brustjs/client). Use signal/computed ' +
        'from brustjs/store; keep behaviors react-free.',
    )
  }
  return { outDir, count: components.size }
}
