import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { buildDevClientTag } from '../dev/client.ts'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'

/** Dev-only: splice the /_brust/dev WS client `<script>` into a compiled native
 * template so `native: true` (jinja) routes auto-reload like React-SSR routes.
 *
 * Native routes render Rust-side on the fast lane, bypassing the React renderer
 * that injects the dev client (runtime/render/stream.ts) — so without this the
 * browser on a native page never opens the dev WS and can never auto-reload.
 *
 * Inserted before the first `</head>` when the page has one (a `<BrustPage>`
 * shell); otherwise appended (bare-fragment pages like a plain `<div>`). The
 * browser executes the module script in either position. Gated on `BRUST_DEV`
 * so `brust build` never bakes it into production templates. */
function injectDevClientIntoTemplate(template: string): string {
  const tag = buildDevClientTag()
  if (template.includes(tag)) return template // idempotent across re-emits
  const headClose = template.indexOf('</head>')
  if (headClose !== -1) {
    return template.slice(0, headClose) + tag + template.slice(headClose)
  }
  return template + tag
}

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

/** Raw component entry from compileJsx's `componentsJson` field. camelCase keys
 * match what Rust's `components_to_json` emits. */
interface RawComponentEntry {
  component: string
  instance: number
  factoryExpr: string
  referencedComponents: string[]
  usesIsland: boolean
  /** ISR cache fields (present only on components with an `isr` attr). Declared
   * so the `{ ...entry }` / `{ ...e }` enrich spreads below are type-complete —
   * they MUST survive into the enriched `<Name>.components.json`, or runtime ISR
   * caching for SSR components silently never activates. Mirrors RawIslandEntry. */
  keyPath?: string
  tagsPath?: string
  revalidate?: number
}

/** Enriched component entry written to `<Name>.components.json`. */
interface EnrichedComponentEntry extends RawComponentEntry {
  /** Absolute path to the component's source file (resolved from page imports). */
  sourcePath: string
}

/** One entry in a `<Name>.islands.json` as emitted by `jsx-rustc` (camelCase,
 * see crates/jsx-rust-compiler/src/lib.rs). Enriched with `sourcePath`. */
interface RawIslandEntry {
  component: string
  instance: number
  propsPath: string
  ssr: boolean
  hydrate: string
  /** ISR cache fields (present only on islands with an `isr` attr). Declared so
   * reconcile's `{ ...entry }` spread is type-complete — they MUST survive into
   * the enriched manifest, or runtime ISR caching silently never activates. */
  keyPath?: string
  tagsPath?: string
  revalidate?: number
}
interface EnrichedIslandEntry extends RawIslandEntry {
  /** Absolute path to the island's client source, resolved from the page's
   * own `import <component> from "..."` declaration. */
  sourcePath: string
}

/** Build a portable ESM specifier (forward slashes, kept `./`/`../`-prefixed)
 * for `to` interpreted against directory `from`. Used for the factory's
 * component imports so they resolve relative to the factory FILE at runtime
 * instead of baking the build machine's absolute path. */
function toRelativeSpecifier(from: string, to: string): string {
  const rel = relative(from, to).replaceAll('\\', '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** Write `<Name>.components.json` and `<Name>.factory.ts` for a native route
 * that has SSR components. Also scans each SSR component's source for Island
 * `component={X}` references and returns those identifiers so the build step
 * can ensure their JS chunks are built.
 *
 * Both artifacts use PROJECT-RELATIVE paths, never the build machine's absolute
 * path: `components.json` stores `sourcePath` relative to the project root
 * (cwd); `.factory.ts` imports relative to its own location (`.brust/jinja/`).
 * `enriched` keeps the ABSOLUTE path internally for the build-time island scan
 * below (`readFileSync`). */
function emitComponentArtifacts(
  jinjaPath: string,
  componentsJsonStr: string,
  pageImports: Map<string, string>,
  routeName: string,
): { islandIdsFromComponents: string[] } {
  const raw = JSON.parse(componentsJsonStr) as RawComponentEntry[]
  if (raw.length === 0) return { islandIdsFromComponents: [] }

  const jinjaDir = dirname(jinjaPath)
  const projectRoot = process.cwd()

  // Enrich with ABSOLUTE source paths resolved from page's own imports — kept
  // absolute for the readFileSync island scan further down.
  const enriched: EnrichedComponentEntry[] = raw.map((entry) => {
    const sourcePath = pageImports.get(entry.component)
    if (!sourcePath) {
      throw new Error(
        `SSR component "${entry.component}" in native route "${routeName}" has no matching import in the page source (expected \`import ${entry.component} from "..."\`)`,
      )
    }
    return { ...entry, sourcePath }
  })

  // Write <Name>.components.json with PROJECT-RELATIVE sourcePaths. (sourcePath
  // is build-time metadata — resolveComponentContext imports the factory, not
  // these paths — so relative is purely a portability/readability win.)
  const compJsonPath = jinjaPath.replace(/\.jinja$/, '.components.json')
  const compJsonEntries = enriched.map((e) => ({
    ...e,
    sourcePath: relative(projectRoot, e.sourcePath).replaceAll('\\', '/'),
  }))
  writeFileSync(compJsonPath, JSON.stringify(compJsonEntries))

  // Collect import lines. Deduplicate referenced components.
  const seen = new Set<string>()
  const importLines: string[] = []
  const needsIsland = enriched.some((e) => e.usesIsland)

  // React createElement is always needed.
  importLines.push("import { createElement as h } from 'react'")
  if (needsIsland) {
    importLines.push("import { Island } from 'brustjs'")
  }

  // Import each referenced component RELATIVE to the factory file's own dir so
  // `await import(factory)` resolves them at runtime regardless of where the
  // project lives (no absolute build-machine path baked in).
  const allReferenced = [...new Set(enriched.flatMap((e) => e.referencedComponents))]
  for (const compName of allReferenced) {
    if (seen.has(compName)) continue
    seen.add(compName)
    const srcPath = pageImports.get(compName)
    if (srcPath) {
      const spec = toRelativeSpecifier(jinjaDir, srcPath)
      importLines.push(`import ${compName} from ${JSON.stringify(spec)}`)
    }
  }

  // Scan SSR component sources for <Island component={X}> to discover Island
  // chunk identifiers that don't appear in the page's own .islands.json.
  const islandIdsFromComponents: string[] = []
  const islandAttrRe = /<Island\s[^>]*component=\{(\w+)\}/g
  for (const entry of enriched) {
    try {
      const src = readFileSync(entry.sourcePath, 'utf8')
      islandAttrRe.lastIndex = 0
      for (;;) {
        const m = islandAttrRe.exec(src)
        if (m === null) break
        if (m[1] && !islandIdsFromComponents.includes(m[1]!)) {
          islandIdsFromComponents.push(m[1]!)
        }
      }
    } catch {
      // Unreadable source — skip
    }
  }

  // Write <Name>.factory.ts
  const factoryPath = jinjaPath.replace(/\.jinja$/, '.factory.ts')
  const factoryLines = [
    '// Auto-generated by brust build — do not edit',
    ...importLines,
    '',
    'export const factories: Array<(ctx: any) => any> = [',
    ...enriched.map((e, i) => `  // comp_${i}: ${e.component}\n  ${e.factoryExpr},`),
    ']',
  ]
  writeFileSync(factoryPath, factoryLines.join('\n') + '\n')

  // If any SSR component embeds an Island, bake the importmap + bootstrap into
  // the Jinja template — the same injection reconcileIslandManifest would do.
  // Without this the client bootstrap never loads and nested Islands don't hydrate.
  if (needsIsland) {
    const baked = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
    const currentJinja = readFileSync(jinjaPath, 'utf8')
    if (!currentJinja.includes(baked)) {
      writeFileSync(jinjaPath, currentJinja + baked)
    }
  }

  return { islandIdsFromComponents }
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
    // Dev-only: native routes don't pass through the React renderer's dev-client
    // injection, so splice the /_brust/dev WS script in here. reEmitJinja() runs
    // this on every hot reload, so the script is always present in dev.
    const template =
      process.env.BRUST_DEV === '1'
        ? injectDevClientIntoTemplate(compiled.template)
        : compiled.template
    writeFileSync(outPath, template)
    built.push(name)

    // Page imports are needed for both island reconciliation and SSR component
    // artifact emission — hoist scan here so both code paths can use it.
    const pageImports = scanImports(sourcePath)

    // Islands post-processing. The compiler reports an island manifest ONLY
    // when the route uses <Island>; `"[]"` ⇒ no islands ⇒ leave the .jinja
    // byte-identical (no-island regression). Remove any stale sibling so a
    // route that dropped its islands doesn't reconcile against an old manifest.
    const islandsJsonPath = resolve(opts.outDir, `${name}.islands.json`)
    if (compiled.islandsJson && compiled.islandsJson !== '[]') {
      writeFileSync(islandsJsonPath, compiled.islandsJson)
      reconcileIslandManifest(outPath, islandsJsonPath, pageImports, name)
    } else if (existsSync(islandsJsonPath)) {
      rmSync(islandsJsonPath, { force: true })
    }

    // SSR component artifacts: .components.json + .factory.ts
    const compJsonStr = (compiled as any).componentsJson ?? '[]'
    if (compJsonStr !== '[]') {
      emitComponentArtifacts(outPath, compJsonStr, pageImports, name)
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
