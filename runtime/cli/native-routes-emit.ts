import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** Repo root. Retained for call-site compatibility; native compilation now
   * goes through the napi addon's `compileJsx`, not a target/ binary. */
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

  // Compile through the napi addon's `compileJsx` rather than spawning the
  // `jsx-rustc` binary. The binary only exists in the source tree's target/
  // dir, so spawning it broke `native: true` routes in a published npm install;
  // the addon (`.node`) ships with every platform package, so this path works
  // for source builds and installed projects alike.
  let compileJsx:
    | ((source: string, path: string) => { template: string; islandsJson: string })
    | null = null
  if (nativeRoutes.length > 0) {
    const native = await import('../index.js')
    compileJsx = (native as { compileJsx?: typeof compileJsx }).compileJsx ?? null
    if (typeof compileJsx !== 'function') {
      throw new Error(
        'brust: the native addon does not expose compileJsx — rebuild it with ' +
          '`cd runtime && bun run build` (or update brustjs to a build that ships it).',
      )
    }
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
    let compiled: { template: string; islandsJson: string }
    try {
      compiled = compileJsx!(readFileSync(sourcePath, 'utf8'), sourcePath)
    } catch (e) {
      throw new Error(`native route "${name}" failed to compile (${sourcePath}):\n${String(e)}`)
    }
    writeFileSync(outPath, compiled.template)
    built.push(name)

    // Islands post-processing. The compiler reports an island manifest ONLY
    // when the route uses <Island>; `"[]"` ⇒ no islands ⇒ leave the .jinja
    // byte-identical (no-island regression). Remove any stale sibling so a
    // route that dropped its islands doesn't reconcile against an old manifest.
    const islandsJsonPath = resolve(opts.outDir, `${name}.islands.json`)
    if (compiled.islandsJson && compiled.islandsJson !== '[]') {
      writeFileSync(islandsJsonPath, compiled.islandsJson)
      // Island source paths resolve from the PAGE file's own imports.
      const pageImports = scanImports(sourcePath)
      reconcileIslandManifest(outPath, islandsJsonPath, pageImports, name)
    } else if (existsSync(islandsJsonPath)) {
      rmSync(islandsJsonPath, { force: true })
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
