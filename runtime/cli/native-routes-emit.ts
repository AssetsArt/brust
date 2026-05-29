import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'

/** Sub-project J — build pass that turns user's `pages/<Name>.tsx` files into
 * `.brust/jinja/<Name>.jinja` templates. Invoked from `brust build` and
 * `brust dev` after the user's routes are flattened.
 *
 * Limitations (spec §7 + §13.10):
 * - Regex-based import scanner — handles `import Name from './path'` only.
 *   Full swc AST + re-export chain support deferred to v2.x.
 * - Dev mode does NOT hot-reload templates on .tsx edit. Boot-only; restart
 *   required. Deferred per spec §12.
 */

export interface NativeRouteEmitOpts {
  /** User's routes entry file (absolute path). Scanned for ImportDeclarations
   * to resolve each native: true route's Component to its source .tsx. */
  entryFile: string
  /** Flat routes array; only entries with `nativeTemplate` are emitted. */
  flatRoutes: { nativeTemplate?: string }[]
  /** `.brust/jinja` absolute output dir. Created if missing. */
  outDir: string
  /** Repo root — used to resolve the `jsx-rustc` binary. */
  repoRoot: string
}

/** One entry in a `<Name>.islands.json` as emitted by `jsx-rustc` (camelCase,
 * see crates/jsx-rust-compiler/src/lib.rs). Enriched with `sourcePath`. */
interface RawIslandEntry {
  component: string
  instance: number
  propsPath: string
  ssr: boolean
  hydrate: string
}
interface EnrichedIslandEntry extends RawIslandEntry {
  /** Absolute path to the island's client source, resolved from the page's
   * own `import <component> from "..."` declaration. */
  sourcePath: string
}

export async function emitNativeTemplates(opts: NativeRouteEmitOpts): Promise<void> {
  mkdirSync(opts.outDir, { recursive: true })

  const nativeRoutes = opts.flatRoutes.filter((r) => r.nativeTemplate)

  // Resolve jsx-rustc binary: prefer release, fall back to debug.
  const jsxRustcRelease = resolve(opts.repoRoot, 'target/release/jsx-rustc')
  const jsxRustcDebug = resolve(opts.repoRoot, 'target/debug/jsx-rustc')
  const jsxRustc = existsSync(jsxRustcRelease)
    ? jsxRustcRelease
    : existsSync(jsxRustcDebug)
      ? jsxRustcDebug
      : null

  if (!jsxRustc && nativeRoutes.length > 0) {
    throw new Error(
      'jsx-rustc binary not found in target/{release,debug}/; ' +
        'run `cargo build -p jsx-rust-compiler --bin jsx-rustc`',
    )
  }

  const importMap =
    nativeRoutes.length > 0 ? scanImports(opts.entryFile) : new Map<string, string>()

  const built: string[] = []
  for (const r of nativeRoutes) {
    const name = r.nativeTemplate!
    const sourcePath = importMap.get(name)
    if (!sourcePath) {
      console.warn(
        `[brust build] no import for native route "${name}" in ${opts.entryFile}; skipping`,
      )
      continue
    }
    const outPath = resolve(opts.outDir, `${name}.jinja`)
    const result = Bun.spawnSync({
      cmd: [jsxRustc!, sourcePath, '-o', outPath],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ''
      const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : ''
      throw new Error(`jsx-rustc failed for ${sourcePath}:\n${stdout}\n${stderr}`)
    }
    built.push(name)

    // Islands post-processing. jsx-rustc writes `<Name>.islands.json` ONLY when
    // the route uses <Island>; absent file ⇒ no islands ⇒ leave the .jinja
    // byte-identical (no-island regression).
    const islandsJsonPath = resolve(opts.outDir, `${name}.islands.json`)
    if (existsSync(islandsJsonPath)) {
      // Island source paths resolve from the PAGE file's own imports.
      const pageImports = scanImports(sourcePath)
      reconcileIslandManifest(outPath, islandsJsonPath, pageImports, name)
    }
  }

  writeFileSync(
    resolve(opts.outDir, '_manifest.json'),
    JSON.stringify({ templates: built, generatedAt: new Date().toISOString() }, null, 2),
  )
}

/** Scan the entry file's `import Name from './path'` declarations and build a
 * map of localName -> resolved absolute path. Extension resolution tries
 * `.tsx`, `.ts`, `/index.tsx`, `/index.ts` in order. */
export function scanImports(entryFile: string): Map<string, string> {
  const source = readFileSync(entryFile, 'utf8')
  const map = new Map<string, string>()
  // Regex-based scanner; full swc AST scan deferred per spec §7 + §13.10.
  const re = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const localName = m[1]!
    const importPath = m[2]!
    if (!importPath.startsWith('.')) continue // skip package imports
    const baseDir = dirname(entryFile)
    const resolved = resolve(baseDir, importPath)
    const candidates = [
      `${resolved}.tsx`,
      `${resolved}.ts`,
      `${resolved}/index.tsx`,
      `${resolved}/index.ts`,
    ]
    const found = candidates.find((p) => existsSync(p))
    if (found) map.set(localName, found)
  }
  return map
}

/** Reconcile the raw `<Name>.islands.json` jsx-rustc emitted against the page's
 * own imports, then bake the importmap+bootstrap into the `.jinja`.
 *
 * Pure-ish & synchronous (fs only) so it unit-tests deterministically:
 * 1. If `islandsJsonPath` is absent → no-op (the route has no islands; the
 *    `.jinja` stays byte-identical).
 * 2. Resolve every entry's `sourcePath` from the page's `import <component>
 *    from "..."` (else throw).
 * 3. Enrich each entry with that absolute `sourcePath` and rewrite the
 *    `.islands.json`.
 * 4. Append `{% raw %}…{% endraw %}`-wrapped bootstrap to the `.jinja`. The raw
 *    block keeps the importmap's literal `}}`/`{{` inert through minijinja's
 *    boot-time compile.
 */
export function reconcileIslandManifest(
  jinjaPath: string,
  islandsJsonPath: string,
  pageImports: Map<string, string>,
  routeName: string,
): void {
  if (!existsSync(islandsJsonPath)) return

  const raw = JSON.parse(readFileSync(islandsJsonPath, 'utf8')) as RawIslandEntry[]

  const enriched: EnrichedIslandEntry[] = raw.map((entry) => {
    const sourcePath = pageImports.get(entry.component)
    if (!sourcePath) {
      throw new Error(
        `island component "${entry.component}" in native route "${routeName}" has no matching import in the page source (expected \`import ${entry.component} from "..."\`)`,
      )
    }
    return { ...entry, sourcePath }
  })

  writeFileSync(islandsJsonPath, JSON.stringify(enriched))

  const baked = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
  writeFileSync(jinjaPath, readFileSync(jinjaPath, 'utf8') + baked)
}
