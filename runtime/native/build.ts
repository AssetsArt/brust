import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { scanImports } from '../cli/native-routes-emit.ts'

const BEHAVIOR_RE = /export\s+const\s+behavior\b/

/** The single island-vs-behavior classifier: a component source is a native
 * behavior component iff it has `export const behavior`. Shared by
 * `scanDirectiveComponents` and the md emit step (runtime/md/emit.ts) so the
 * two paths can never diverge. */
export function isBehaviorSource(src: string): boolean {
  return BEHAVIOR_RE.test(src)
}

/** Deterministic, app-unique directive name = camelCase(basename) + "_" + 8 hex of
 *  sha256(cwd-relative path). The SINGLE name contract: chunk filename, runtime
 *  registry key, and the compiler-emitted `x-data` all derive from this. */
export function directiveName(absPath: string, projectRoot: string): string {
  const base = basename(absPath, extname(absPath))
  const camel = base.length > 0 ? base[0]!.toLowerCase() + base.slice(1) : base
  const rel = relative(projectRoot, absPath).replaceAll('\\', '/')
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8)
  return `${camel}_${hash}`
}

/** BFS the local import graph from the routes entry; return directiveName →
 * absolute sourcePath for every file that has `export const behavior`. Throws on
 * two distinct files deriving the same directive name (path-hashed, collision-resistant). */
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
    if (isBehaviorSource(src)) {
      const name = directiveName(filePath, process.cwd())
      const existing = found.get(name)
      if (existing && existing !== filePath) {
        throw new Error(
          `directive component name "${name}" (path-hashed) derives from two files (${existing} and ${filePath}); this should be impossible — please report a bug`,
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
  /** All emitted filenames (basenames): `_directives.js` (the shared runtime) plus
   * one `<name>.directive.js` per component. Callers mirror these into .brust/islands. */
  files: string[]
}

// Absolute path to the directive runtime source — bundled into `_directives.js`.
const RUNTIME_SRC = resolve(import.meta.dir, 'runtime.ts')

async function bundleOne(entryPath: string, outDir: string, naming: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: outDir,
    naming,
    format: 'esm',
    target: 'browser',
    external: [], // self-contained; react (if any leaks in) is caught by the guard
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!result.success) {
    throw new Error(
      `buildDirectives: Bun.build failed:\n${result.logs.map((l) => String(l)).join('\n')}`,
    )
  }
}

function assertReactFree(file: string): void {
  if (REACT_MARKER_RE.test(readFileSync(file, 'utf8'))) {
    throw new Error(
      `buildDirectives: React leaked into ${file.split('/').pop()} — a behavior imported a ` +
        'react-pulling symbol (e.g. useStore from brustjs/client). Use signal/computed ' +
        'from brustjs/store; keep behaviors react-free.',
    )
  }
}

// React-presence markers in a bundled output. `external: []` inlines react, so we
// match React's stable runtime strings rather than a bare `react` import specifier.
// `__SECRET_INTERNALS` is React 18's name; `__CLIENT_INTERNALS` is React 19's — both
// kept so the guard fires regardless of the react major. `react.dev` is the error-URL
// baked into react's dev/prod runtime; `useSyncExternalStore` is the hook `useStore`
// pulls. `createRoot`/`hydrateRoot`/`react-dom` catch a react-dom (client render) leak.
const REACT_MARKER_RE =
  /createRoot|hydrateRoot|react-dom|__SECRET_INTERNALS|__CLIENT_INTERNALS|react\.dev|useSyncExternalStore/

/** Build the shared directive runtime (`_directives.js`, loaded on every native page)
 * PLUS one `<name>.directive.js` chunk per component (loaded ON DEMAND by the runtime
 * when an `x-data="<name>"` appears). Splitting behaviors into per-component chunks
 * keeps a page from downloading the JS of components it never renders; the runtime
 * dynamically `import()`s a chunk the first time its name is seen (initial or post
 * SPA-nav). Each chunk self-registers via the global `register` handle (so it needs
 * no runtime import). React must not leak into any chunk — asserted per file. */
export async function buildDirectives(
  components: Map<string, string>,
  options: { outDir: string },
): Promise<BuildDirectivesResult> {
  const outDir = isAbsolute(options.outDir)
    ? options.outDir
    : resolve(process.cwd(), options.outDir)
  mkdirSync(outDir, { recursive: true })
  if (components.size === 0) return { outDir, count: 0, files: [] }

  const files: string[] = []

  // 1. Shared runtime → _directives.js. Importing runtime.ts runs its module body
  //    (which exposes `register` on the global), then start() boots scan + observer.
  const runtimeEntry = resolve(outDir, '_directives.entry.ts')
  writeFileSync(runtimeEntry, `import { start } from ${JSON.stringify(RUNTIME_SRC)}\nstart()\n`)
  try {
    await bundleOne(runtimeEntry, outDir, '_directives.js')
  } finally {
    rmSync(runtimeEntry, { force: true })
  }
  assertReactFree(resolve(outDir, '_directives.js'))
  files.push('_directives.js')

  // 2. Per-component behavior chunks → <name>.directive.js. Each self-registers into
  //    the shared runtime via the global handle (no runtime import → tiny chunk).
  for (const [name, src] of components) {
    const entry = resolve(outDir, `${name}.directive.entry.ts`)
    writeFileSync(
      entry,
      `import { behavior } from ${JSON.stringify(src)}\n` +
        `;(globalThis as Record<symbol, (n: string, b: unknown) => void>)` +
        `[Symbol.for('brust.directive.register')](${JSON.stringify(name)}, behavior)\n`,
    )
    const chunkName = `${name}.directive.js`
    try {
      await bundleOne(entry, outDir, chunkName)
    } finally {
      rmSync(entry, { force: true })
    }
    assertReactFree(resolve(outDir, chunkName))
    files.push(chunkName)
  }

  return { outDir, count: components.size, files }
}
