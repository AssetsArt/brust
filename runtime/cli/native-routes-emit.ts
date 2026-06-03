import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { buildDevClientTag } from '../dev/client.ts'
import { DIRECTIVES_BOOTSTRAP, ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'

/** Gather transitive component sources starting from a page source file.
 *
 * BFS/DFS over local imports reachable from `pageSourcePath`:
 * - Reads each file's source text and adds it to `sources[ident]`.
 * - Recursively follows local imports in each visited file.
 * - Deduplicates by resolved path to handle cycles.
 * - `mergedImports` is the union of every visited file's `scanImports`, with
 *   the page's own imports taking precedence on a conflicting ident.
 *
 * Throws when the same ident resolves to two different absolute paths (across
 * two different importing files) — that would be ambiguous for the Rust
 * compiler. */
export function gatherComponentSources(pageSourcePath: string): {
  sources: Record<string, string>
  mergedImports: Map<string, string>
} {
  const sources: Record<string, string> = {}
  // mergedImports accumulates ident→resolvedPath across ALL visited files.
  // The page's own imports win on conflict (inserted last below).
  const mergedImports = new Map<string, string>()
  const visited = new Set<string>()

  // Queue items: { ident, resolvedPath } — ident is how the PARENT imported it.
  // We start with the children of pageSourcePath (not the page itself).
  function visit(filePath: string, ident: string) {
    if (visited.has(filePath)) return
    visited.add(filePath)

    const sourceText = readFileSync(filePath, 'utf8')

    // Record source keyed by ident — detect ambiguity.
    if (ident in sources) {
      // Same ident already seen — only an error if it resolves to a different path.
      // We get the previous path from mergedImports (which maps ident → resolvedPath).
      const existingPath = mergedImports.get(ident)
      if (existingPath && existingPath !== filePath) {
        throw new Error(
          `native build: ambiguous component ident "${ident}" resolves to two paths: ${existingPath} and ${filePath}`,
        )
      }
    } else {
      sources[ident] = sourceText
    }

    // Scan this file's imports and recurse into local ones.
    const childImports = scanImports(filePath)
    for (const [childIdent, childPath] of childImports) {
      // Merge into mergedImports — check for ambiguity.
      const existing = mergedImports.get(childIdent)
      if (existing !== undefined && existing !== childPath) {
        throw new Error(
          `native build: ambiguous component ident "${childIdent}" resolves to two paths: ${existing} and ${childPath}`,
        )
      }
      if (existing === undefined) {
        mergedImports.set(childIdent, childPath)
      }
      // Recurse into local files (skip node_modules / unresolved paths).
      if (!childPath.includes('node_modules')) {
        visit(childPath, childIdent)
      }
    }
  }

  // Seed: scan the page's own imports and visit each local file.
  const pageImports = scanImports(pageSourcePath)
  for (const [ident, resolvedPath] of pageImports) {
    if (!resolvedPath.includes('node_modules')) {
      visit(resolvedPath, ident)
    }
  }

  // Page's own imports win on ident conflict — merge them last.
  for (const [ident, resolvedPath] of pageImports) {
    mergedImports.set(ident, resolvedPath)
  }

  return { sources, mergedImports }
}

/** T2 / B1 fix — gather component sources for an ENTIRE native chain.
 *
 * The leaf of a composed chain is a bare fragment that no longer imports its
 * ancestors, so seeding `gatherComponentSources` from the leaf alone would
 * leave every ancestor's source ABSENT — `<AppLayout native>` would then
 * silently soft-fall to an SsrComponent (React render) and break native. This
 * unions `gatherComponentSources` over EVERY chain component's resolved source
 * file (resolved name→file via the entry's `importMap`), then injects each
 * chain component's OWN source keyed by its ident.
 *
 * Returns the merged `sources` map and `mergedImports` (ident→absolute path).
 * Post-condition: `sources` has a key for every chain component name. Throws if
 * a chain component name can't be resolved to a source file via `importMap`. */
export function gatherChainSources(
  chainNames: string[],
  importMap: Map<string, string>,
): { sources: Record<string, string>; mergedImports: Map<string, string> } {
  const sources: Record<string, string> = {}
  const mergedImports = new Map<string, string>()

  for (const compName of chainNames) {
    const compPath = importMap.get(compName)
    if (!compPath) {
      throw new Error(
        `native chain component "${compName}" has no matching import in the routes entry ` +
          `(expected \`import ${compName} from "..."\`)`,
      )
    }

    // Union the transitive sources reachable from THIS chain component.
    const { sources: subSources, mergedImports: subImports } = gatherComponentSources(compPath)
    for (const [ident, src] of Object.entries(subSources)) {
      if (ident in sources && sources[ident] !== src) {
        throw new Error(
          `native build: ambiguous component ident "${ident}" — two different sources in one chain`,
        )
      }
      sources[ident] = src
    }
    for (const [ident, p] of subImports) {
      const existing = mergedImports.get(ident)
      if (existing !== undefined && existing !== p) {
        throw new Error(
          `native build: ambiguous component ident "${ident}" resolves to two paths: ${existing} and ${p}`,
        )
      }
      mergedImports.set(ident, p)
    }

    // Inject the chain component's OWN source keyed by its ident — it is the
    // route source for `gatherComponentSources(compPath)` (which seeds from the
    // file's imports, not the file itself), so it would otherwise be missing.
    const ownSrc = readFileSync(compPath, 'utf8')
    if (compName in sources && sources[compName] !== ownSrc) {
      throw new Error(
        `native build: ambiguous component ident "${compName}" — two different sources in one chain`,
      )
    }
    sources[compName] = ownSrc
    mergedImports.set(compName, compPath)
  }

  return { sources, mergedImports }
}

/** T2 — build the synthetic wrapper SOURCE STRING for a native route chain.
 *
 * Given the component identifiers parent→leaf (e.g. `['AppLayout', 'Leaf']`),
 * emit a default-exported function whose body nests every component, leaf
 * innermost, with the `native` attribute on EVERY tag:
 *
 *   export default function Leaf__chain() { return <AppLayout native><Leaf native/></AppLayout>; }
 *
 * Load-bearing details:
 * - `export default function` is required — the Rust compiler's
 *   `find_default_export` only matches that exact form.
 * - `native` on every tag — without it a nested component lowers to an
 *   SsrComponent (React render) instead of being inlined into the chain.
 * - The leaf tag is self-closing; each ancestor wraps the next via `<Outlet/>`
 *   inside the ancestor's own source (the compiler substitutes the children
 *   slot for `<Outlet/>`).
 *
 * The wrapper function name is `${leafName}__chain` — purely cosmetic (the
 * compiler keys off the default export, not the name). */
export function buildChainWrapperSource(chainNames: string[]): string {
  if (chainNames.length < 2) {
    throw new Error(
      `buildChainWrapperSource requires a chain of length >= 2 (got ${chainNames.length})`,
    )
  }
  // The names are interpolated raw into a JSX source string fed to the compiler.
  // They come from `Component.name` (build-time idents) so injection isn't a real
  // attack surface, but a pathological name would emit malformed JSX (a confusing
  // compiler parse error) — reject anything that isn't a valid component identifier.
  for (const name of chainNames) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(
        `native chain component name is not a valid identifier: ${JSON.stringify(name)}`,
      )
    }
  }
  const leafName = chainNames[chainNames.length - 1]!
  // Build nested JSX inner→outer: <Leaf native/> wrapped by each ancestor.
  let jsx = `<${leafName} native/>`
  for (let i = chainNames.length - 2; i >= 0; i--) {
    const name = chainNames[i]!
    jsx = `<${name} native>${jsx}</${name}>`
  }
  return `export default function ${leafName}__chain() { return ${jsx}; }`
}

/** Count opening `<main>` tags in a compiled template. SPA navigation extracts
 * the FIRST `<main>…</main>` block (routes.ts), so a composed native template
 * must contain exactly one `<main>` — the layout owns it and leaf fragments must
 * not add their own. More than one silently truncates the SPA-nav payload. */
export function countMainTags(template: string): number {
  return (template.match(/<main[\s/>]/g) ?? []).length
}

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

/** Bake the directive runtime loader into a native template iff it uses any
 * x-data directive. Idempotent. Wrapped in {% raw %} for symmetry with the islands
 * bootstrap bake (the tag has no {{ }} but the wrap is harmless + consistent). */
export function bakeDirectivesIfUsed(template: string, force = false): string {
  // `force` (app has ≥1 directive component) bakes on EVERY native page so the
  // runtime is live to catch SPA-nav swaps into a directive page. Otherwise
  // attribute-anchored (`x-data=`) so a literal "x-data" in text/content can't
  // trigger a stray <script> that would 404 (no bundle built for that route).
  if (!force && !/x-data=/.test(template)) return template
  const baked = `{% raw %}${DIRECTIVES_BOOTSTRAP}{% endraw %}`
  if (template.includes(baked)) return template
  return template + baked
}

/** Sub-project J — build pass that turns user's `pages/<Name>.tsx` files into
 * `.brust/jinja/<Name>.jinja` templates. Invoked from `brust build` and
 * `brust dev` after the user's routes are flattened.
 *
 * Limitations (spec S7 + S13.10):
 * - Regex-based import scanner — handles `import Name from './path'` only.
 *   Full swc AST + re-export chain support deferred to v2.x.
 * - Dev mode does NOT hot-reload templates on .tsx edit. Boot-only; restart
 *   required. Deferred per spec S12.
 */

export interface NativeRouteEmitOpts {
  /** User's routes entry file (absolute path). Scanned for ImportDeclarations
   * to resolve each native: true route's Component to its source .tsx. */
  entryFile: string
  /** Flat routes array; only entries with `nativeTemplate` are emitted. The
   * runtime objects are full FlatRoutes — `chain` (parent→leaf route nodes,
   * each carrying its `Component`) drives T2 native-chain composition. */
  flatRoutes: {
    nativeTemplate?: string
    chain?: Array<{ Component?: { name?: string } }>
  }[]
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
    | ((
        source: string,
        path: string,
        componentSources?: Record<string, string>,
      ) => { template: string; islandsJson: string; warnings?: string[] })
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

  // App-wide directive presence: if ANY native interactive component exists, the
  // directive runtime (`_directives.js`) must load on EVERY native page — not just
  // pages whose own template uses x-data. SPA nav (owned by the islands bootstrap)
  // swaps <main> but does NOT execute <script> tags in the swapped HTML, so the
  // runtime must already be live on the page you navigate FROM for its
  // MutationObserver to mount the incoming x-data. Dynamic import = call-time
  // (avoids a module-eval cycle with native/build.ts → scanImports here).
  const hasDirectives =
    nativeRoutes.length > 0 &&
    (await import('../native/build.ts')).scanDirectiveComponents(opts.entryFile).size > 0

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

    // T2 — derive the route chain (parent→leaf component idents). A chain of
    // length > 1 is a NESTED native route: synthesize a per-leaf wrapper that
    // composes the whole chain into one native template, and gather sources for
    // every chain component (B1 fix). Output stays under the LEAF's template
    // name so the Rust route table is unchanged.
    const chain = r.chain ?? []
    const chainNames = chain
      .map((node) => node.Component?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    // A nested route (chain.length > 1) whose names collapsed (anonymous/missing
    // Component.name) must NOT silently fall through to the flat path — that would
    // emit the leaf-only template and drop the layout. Fail loud instead.
    if (chain.length > 1 && chainNames.length !== chain.length) {
      throw new Error(
        `native nested route "${name}" has ${chain.length} chain levels but only ${chainNames.length} named components — every level needs a named component`,
      )
    }

    // Route source + sources map fed to the compiler. For a flat route
    // (chain.length <= 1) this is the leaf source itself, seeded from its own
    // imports — the EXISTING, untouched code path (no synth, no regression).
    let routeSource: string
    let routeSourcePath: string
    let sources: Record<string, string>
    let mergedImports: Map<string, string>
    if (chainNames.length > 1) {
      routeSource = buildChainWrapperSource(chainNames)
      // Synthetic path: a placeholder under the leaf's dir. The compiler keys
      // off the default export + componentSources, not a real file on disk.
      routeSourcePath = resolve(dirname(sourcePath), `${name}__chain.tsx`)
      ;({ sources, mergedImports } = gatherChainSources(chainNames, importMap))
    } else {
      // Gather transitive component sources for native inlining and build the
      // merged import map that covers nested components (e.g. islands inside an
      // inlined native component that don't appear in the page's own imports).
      routeSource = readFileSync(sourcePath, 'utf8')
      routeSourcePath = sourcePath
      ;({ sources, mergedImports } = gatherComponentSources(sourcePath))
    }

    let compiled: { template: string; islandsJson: string; warnings?: string[] }
    try {
      compiled = compileJsx!(routeSource, routeSourcePath, sources)
    } catch (e) {
      throw new Error(
        `native route "${name}" failed to compile (${routeSourcePath}):\n${String(e)}`,
      )
    }

    // Print non-fatal compiler warnings to stderr.
    for (const w of compiled.warnings ?? []) process.stderr.write(`brust: ${w}\n`)

    // SPA navigation extracts the FIRST <main>…</main> block, so a native route
    // template must hold exactly one <main>. More than one (typically a leaf
    // fragment adding its own under a layout that already owns one) silently
    // truncates the nav payload — warn at build time (convention: layout owns <main>).
    if (countMainTags(compiled.template) > 1) {
      process.stderr.write(
        `brust: native route "${name}" has more than one <main> — SPA navigation extracts only the first <main>…</main>. ` +
          `Keep a single <main> (the layout owns it; leaf fragments must not add their own).\n`,
      )
    }

    // Dev-only: native routes don't pass through the React renderer's dev-client
    // injection, so splice the /_brust/dev WS script in here. reEmitJinja() runs
    // this on every hot reload, so the script is always present in dev.
    const withDirectives = bakeDirectivesIfUsed(compiled.template, hasDirectives)
    const template =
      process.env.BRUST_DEV === '1' ? injectDevClientIntoTemplate(withDirectives) : withDirectives
    writeFileSync(outPath, template)
    built.push(name)

    // Islands post-processing. The compiler reports an island manifest ONLY
    // when the route uses <Island>; `"[]"` ⇒ no islands ⇒ leave the .jinja
    // byte-identical (no-island regression). Remove any stale sibling so a
    // route that dropped its islands doesn't reconcile against an old manifest.
    const islandsJsonPath = resolve(opts.outDir, `${name}.islands.json`)
    if (compiled.islandsJson && compiled.islandsJson !== '[]') {
      writeFileSync(islandsJsonPath, compiled.islandsJson)
      reconcileIslandManifest(outPath, islandsJsonPath, mergedImports, name)
    } else if (existsSync(islandsJsonPath)) {
      rmSync(islandsJsonPath, { force: true })
    }

    // SSR component artifacts: .components.json + .factory.ts
    const compJsonStr = (compiled as any).componentsJson ?? '[]'
    if (compJsonStr !== '[]') {
      emitComponentArtifacts(outPath, compJsonStr, mergedImports, name)
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
  // Regex-based scanner; full swc AST scan deferred per spec S7 + S13.10.
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

  // sourcePath is written PROJECT-RELATIVE (relative to the build's cwd), never
  // the build machine's absolute path — the absolute path leaks the developer's
  // username into shipped dist/jinja artifacts, and a relative path survives the
  // dual-emit copy into `.brust/jinja` (both dirs sit directly under cwd, so the
  // same relative string resolves correctly from either). The runtime
  // (`loadIslandManifest`) rehydrates it to an absolute path against cwd before
  // the SSR import. Mirrors the .components.json contract (emitComponentArtifacts).
  const projectRoot = process.cwd()
  const enriched: EnrichedIslandEntry[] = raw.map((entry) => {
    const sourcePath = pageImports.get(entry.component)
    if (!sourcePath) {
      throw new Error(
        `island component "${entry.component}" in native route "${routeName}" has no matching import in the page source (expected \`import ${entry.component} from "..."\`)`,
      )
    }
    return { ...entry, sourcePath: relative(projectRoot, sourcePath).replaceAll('\\', '/') }
  })

  writeFileSync(islandsJsonPath, JSON.stringify(enriched))

  const baked = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
  writeFileSync(jinjaPath, readFileSync(jinjaPath, 'utf8') + baked)
}
