import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { buildDevClientTag } from '../dev/client.ts'
import { insertGeneratorMeta, resolveGenerator } from '../generator.ts'
import { islandChunkBasename } from '../islands/chunk-id.ts'
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
  mergedImports: Map<string, ResolvedImport>
} {
  const sources: Record<string, string> = {}
  // mergedImports accumulates ident→ResolvedImport across ALL visited files.
  // The page's own imports win on conflict (inserted last below).
  const mergedImports = new Map<string, ResolvedImport>()
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
      // We get the previous spec from mergedImports (which maps ident → ResolvedImport).
      const existing = mergedImports.get(ident)
      if (existing && existing.spec !== filePath) {
        throw new Error(
          `native build: ambiguous component ident "${ident}" resolves to two paths: ${existing.spec} and ${filePath}`,
        )
      }
    } else {
      sources[ident] = sourceText
    }

    // Scan this file's imports and recurse into local ones.
    const childImports = scanImportRefs(filePath)
    for (const [childIdent, ref] of childImports) {
      // Merge into mergedImports — check for ambiguity (compare by spec). Only
      // Capitalized idents can be COMPONENT sources; lowercase idents (stores,
      // hooks, utils) legitimately repeat across files and must not throw.
      const existing = mergedImports.get(childIdent)
      if (existing !== undefined && existing.spec !== ref.spec) {
        if (isComponentIdent(childIdent)) {
          throw new Error(
            `native build: ambiguous component ident "${childIdent}" resolves to two paths: ${existing.spec} and ${ref.spec}`,
          )
        }
        // Non-component collision — keep the first, don't recurse the duplicate.
        continue
      }
      if (existing === undefined) {
        mergedImports.set(childIdent, ref)
      }
      // Recurse into LOCAL files only (a bare spec has no readable file —
      // !bare, not the old node_modules string-check which a bare spec evades).
      if (!ref.bare) {
        visit(ref.spec, childIdent)
      }
    }
  }

  // Seed: scan the page's own imports and visit each local file.
  const pageImports = scanImportRefs(pageSourcePath)
  for (const [ident, ref] of pageImports) {
    if (!ref.bare) {
      visit(ref.spec, ident)
    }
  }

  // Page's own imports win on ident conflict — merge them last.
  for (const [ident, ref] of pageImports) {
    mergedImports.set(ident, ref)
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
): { sources: Record<string, string>; mergedImports: Map<string, ResolvedImport> } {
  const sources: Record<string, string> = {}
  const mergedImports = new Map<string, ResolvedImport>()

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
        // Only Capitalized idents are COMPONENT sources; a lowercase collision
        // (e.g. two stores both named `teamStore`) is legitimate — keep first.
        if (isComponentIdent(ident)) {
          throw new Error(
            `native build: ambiguous component ident "${ident}" — two different sources in one chain`,
          )
        }
        continue
      }
      sources[ident] = src
    }
    for (const [ident, ref] of subImports) {
      const existing = mergedImports.get(ident)
      if (existing !== undefined && existing.spec !== ref.spec) {
        if (isComponentIdent(ident)) {
          throw new Error(
            `native build: ambiguous component ident "${ident}" resolves to two paths: ${existing.spec} and ${ref.spec}`,
          )
        }
        continue
      }
      mergedImports.set(ident, ref)
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
    // The chain component is resolved by name from the routes entry — a LOCAL
    // default-imported source file (route-name resolution is local-only).
    mergedImports.set(compName, { spec: compPath, bare: false, kind: 'default' })
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
 * so `brust build` never bakes it into production templates.
 *
 * Exported for the md emit step (runtime/md/emit.ts), which bakes the same tag
 * under its `withDevClient` option — md pages render Rust-side too, so without
 * it they never auto-reload in dev. */
export function injectDevClientIntoTemplate(template: string): string {
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
    /** Chain nodes parent→leaf. A leaf carrying `__mdSource` is a markdown
     * page (runtime/md/routes.ts) — emitted by `emitMdTemplates`, NOT here. */
    chain?: Array<{ Component?: { name?: string }; __mdSource?: unknown }>
  }[]
  /** `.brust/jinja` absolute output dir. Created if missing. */
  outDir: string
  /** Repo root. Retained for call-site compatibility; native compilation now
   * goes through the napi addon's `compileJsx`, not a target/ binary. */
  repoRoot: string
  /** Dev-loop incremental compile (R14). When true, each route's resolved
   * compileJsx inputs (route source + every transitively imported local source
   * + the lucide/directive/component-source env) are content-hashed and memoized
   * for the lifetime of the process; an unchanged route SKIPS compileJsx and the
   * sidecar rewrites (the previous emit's outputs are already on disk) but still
   * appears in the returned manifest. ANY error in hashing falls back to a full
   * compile — correctness over speed. Set only by `brust dev`'s emit calls;
   * `brust build` stays full-fidelity (default false → no memo read OR write,
   * and any stale memo entry for the route is dropped). */
  incremental?: boolean
  /** TEST SEAM — replaces the canonical-input hasher so tests can prove the
   * hash-failure → compile-all fallback. Never set outside tests. */
  hashInputsForTest?: (canonicalInputs: string) => string
}

/** Per-route emit outcome counts for `emitNativeTemplates` — testability seam
 * for the dev-loop incremental memo (R14). `compiled + skipped` = routes
 * emitted (routes dropped for a missing import count in neither). */
export interface NativeEmitStats {
  compiled: number
  skipped: number
}

/** Dev-session memo for the incremental path: `outDir\0templateName` →
 * { hash of the resolved compileJsx inputs, output files written by the last
 * compile }. In-memory only (per dev process, by design — no persistence). */
const nativeEmitMemo = new Map<string, { hash: string; outputs: string[] }>()

/** Clear the incremental memo (test isolation). */
export function resetNativeEmitMemo(): void {
  nativeEmitMemo.clear()
}

/** Key-sorted shallow copy so JSON.stringify is order-independent (gather order
 * is deterministic per content, but sorting makes the hash robust to it). */
function sortRecord(rec: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Canonicalize EVERYTHING that feeds a route's compile + post-processing:
 * the exact compileJsx arguments (route source/path, transitive component
 * sources, lucide icons, directive names), the resolved import refs (they shape
 * the .islands.json/.components.json/.factory.ts sidecars), and the per-emit
 * env that mutates the template after compile (directive force-bake, generator
 * meta, dev-client splice). If it can change the bytes on disk, it is in here. */
function canonicalCompileInputs(input: {
  routeSource: string
  routeSourcePath: string
  sources: Record<string, string>
  lucideIcons: Record<string, string>
  directiveNames: Record<string, string>
  mergedImports: Map<string, ResolvedImport>
  hasDirectives: boolean
  generatorMeta: string
  devClient: boolean
}): string {
  return JSON.stringify({
    routeSource: input.routeSource,
    routeSourcePath: input.routeSourcePath,
    sources: sortRecord(input.sources),
    lucideIcons: sortRecord(input.lucideIcons),
    directiveNames: sortRecord(input.directiveNames),
    imports: [...input.mergedImports.entries()]
      .map(
        ([ident, ref]) =>
          [ident, ref.spec, ref.bare, ref.kind, ref.imported ?? ''] as [
            string,
            string,
            boolean,
            string,
            string,
          ],
      )
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    hasDirectives: input.hasDirectives,
    generatorMeta: input.generatorMeta,
    devClient: input.devClient,
  })
}

/** Default canonical-input hasher (overridable per-call via the test seam). */
function sha256Hex(canonicalInputs: string): string {
  return createHash('sha256').update(canonicalInputs).digest('hex')
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
 * below (`readFileSync`).
 *
 * Exported for the md emit step (runtime/md/emit.ts), whose chained wrappers
 * can carry layout SSR components and need the same sidecar emission. */
export function emitComponentArtifacts(
  jinjaPath: string,
  componentsJsonStr: string,
  pageImports: Map<string, ResolvedImport>,
  routeName: string,
): { islandIdsFromComponents: string[] } {
  const raw = JSON.parse(componentsJsonStr) as RawComponentEntry[]
  if (raw.length === 0) return { islandIdsFromComponents: [] }

  const jinjaDir = dirname(jinjaPath)
  const projectRoot = process.cwd()

  // Enrich with the resolved import ref. For local imports `ref.spec` is an
  // ABSOLUTE path (kept absolute for the readFileSync island scan below); for
  // bare imports it's the verbatim package specifier.
  const enriched: Array<EnrichedComponentEntry & { ref: ResolvedImport }> = raw.map((entry) => {
    const ref = pageImports.get(entry.component)
    if (!ref) {
      throw new Error(
        `SSR component "${entry.component}" in native route "${routeName}" has no matching import in the page source (expected \`import ${entry.component} from "..."\`)`,
      )
    }
    return { ...entry, sourcePath: ref.spec, ref }
  })

  // Write <Name>.components.json. For LOCAL imports sourcePath is PROJECT-RELATIVE
  // (cwd-relative — no build-machine path baked in); for BARE imports it's the
  // package spec verbatim. (sourcePath is build-time metadata — the factory
  // import is what's load-bearing at runtime.)
  const compJsonPath = jinjaPath.replace(/\.jinja$/, '.components.json')
  const compJsonEntries = enriched.map(({ ref, ...e }) => ({
    ...e,
    sourcePath: ref.bare ? ref.spec : relative(projectRoot, ref.spec).replaceAll('\\', '/'),
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

  // Import each referenced component, regenerating the correct import FORM per
  // kind. Local specs are relativized to the factory file's own dir (so
  // `await import(factory)` resolves them at runtime regardless of project
  // location); bare specs are kept verbatim.
  const allReferenced = [...new Set(enriched.flatMap((e) => e.referencedComponents))]
  for (const compName of allReferenced) {
    if (seen.has(compName)) continue
    seen.add(compName)
    const ref = pageImports.get(compName)
    if (!ref) continue
    const spec = ref.bare ? ref.spec : toRelativeSpecifier(jinjaDir, ref.spec)
    const specStr = JSON.stringify(spec)
    if (ref.kind === 'namespace') {
      importLines.push(`import * as ${compName} from ${specStr}`)
    } else if (ref.kind === 'named') {
      // Collapse the redundant `{ X as X }` to `{ X }` when the local name equals
      // the imported name (idiomatic + avoids no-useless-rename lint on the factory).
      const named =
        ref.imported && ref.imported !== compName ? `${ref.imported} as ${compName}` : compName
      importLines.push(`import { ${named} } from ${specStr}`)
    } else {
      importLines.push(`import ${compName} from ${specStr}`)
    }
  }

  // Scan SSR component sources for <Island component={X}> to discover Island
  // chunk identifiers that don't appear in the page's own .islands.json. Bare
  // imports have no readable local file — skip them (no readFileSync attempt).
  const islandIdsFromComponents: string[] = []
  const islandAttrRe = /<Island\s[^>]*component=\{(\w+)\}/g
  for (const entry of enriched) {
    if (entry.ref.bare) continue
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

export async function emitNativeTemplates(opts: NativeRouteEmitOpts): Promise<NativeEmitStats> {
  mkdirSync(opts.outDir, { recursive: true })

  // md-route exclusion lives HERE (not at the call sites): a chain whose LEAF
  // carries `__mdSource` is a markdown page emitted by `emitMdTemplates` —
  // its synthetic template name has no routes-entry import, so letting it
  // through would log a bogus "no import → skip" warning per md page.
  const nativeRoutes = opts.flatRoutes.filter(
    (r) => r.nativeTemplate && !r.chain?.[r.chain.length - 1]?.__mdSource,
  )

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
        lucideIcons?: Record<string, string>,
        directiveNames?: Record<string, string>,
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

  // Generator meta: resolved INTERNALLY from the out dir's artifact (NOT a
  // caller param) — emit re-runs from five call sites (build, dev, boot
  // staleness, md boot re-emit, dev HMR) and a param would silently drop the
  // tag on re-emit. Fallback (no artifact) = version-on defaults.
  const generatorMeta = resolveGenerator(opts.outDir).meta

  const built: string[] = []
  const stats: NativeEmitStats = { compiled: 0, skipped: 0 }
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
    let mergedImports: Map<string, ResolvedImport>
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

    // Lucide icons live in component files (inlined via <Comp native/>), so scan the
    // route file plus every LOCAL component source path for lucide-react imports.
    const lucidePaths = new Set<string>()
    // route file only if it's a real on-disk file (synthetic __chain.tsx is not)
    if (existsSync(routeSourcePath)) lucidePaths.add(routeSourcePath)
    for (const imp of mergedImports.values()) {
      if (!imp.bare && typeof imp.spec === 'string') lucidePaths.add(imp.spec)
    }
    const lucideIcons: Record<string, string> = {}
    for (const p of lucidePaths) Object.assign(lucideIcons, await extractLucideIcons(p))

    // Build directive name map: for each ident in `sources` whose source text
    // contains `export const behavior`, resolve its absolute path from
    // `mergedImports` and derive the canonical directive name. Uses a dynamic
    // import to avoid a circular dependency (native/build.ts → scanImports here).
    const { directiveName } = await import('../native/build.ts')
    const BEHAVIOR_RE = /export\s+const\s+behavior\b/
    const directiveNames: Record<string, string> = {}
    for (const [ident, src] of Object.entries(sources)) {
      if (!BEHAVIOR_RE.test(src)) continue
      const ref = mergedImports.get(ident)
      if (ref && !ref.bare && typeof ref.spec === 'string') {
        directiveNames[ident] = directiveName(ref.spec, process.cwd())
      }
    }

    // R14 — dev incremental memo. EVERYTHING hashed here is the resolved input
    // set: the gather steps above re-read every transitive local source fresh on
    // each emit, so an edit anywhere in the route's import graph changes
    // `sources` (or lucide/directive env) and misses the memo. ANY hashing error
    // → undefined → compile (correctness over speed). Non-incremental calls
    // (brust build, boot staleness) never read the memo and DROP the route's
    // entry below, so a later incremental emit can't trust outputs it didn't
    // verify against this exact hash.
    const memoKey = `${opts.outDir}\0${name}`
    let inputsHash: string | undefined
    if (opts.incremental) {
      try {
        inputsHash = (opts.hashInputsForTest ?? sha256Hex)(
          canonicalCompileInputs({
            routeSource,
            routeSourcePath,
            sources,
            lucideIcons,
            directiveNames,
            mergedImports,
            hasDirectives,
            generatorMeta,
            devClient: process.env.BRUST_DEV === '1',
          }),
        )
      } catch {
        inputsHash = undefined
      }
      const prev = inputsHash !== undefined ? nativeEmitMemo.get(memoKey) : undefined
      if (prev && prev.hash === inputsHash && prev.outputs.every((p) => existsSync(p))) {
        // Unchanged route: the previous emit's .jinja + sidecars are on disk —
        // skip compileJsx and every rewrite, but still report the template.
        built.push(name)
        stats.skipped++
        continue
      }
    }

    let compiled: { template: string; islandsJson: string; warnings?: string[] }
    try {
      compiled = compileJsx!(routeSource, routeSourcePath, sources, lucideIcons, directiveNames)
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
    const withGenerator = insertGeneratorMeta(withDirectives, generatorMeta)
    const template =
      process.env.BRUST_DEV === '1' ? injectDevClientIntoTemplate(withGenerator) : withGenerator
    writeFileSync(outPath, template)
    built.push(name)
    stats.compiled++
    const outputs = [outPath]

    // Islands post-processing. The compiler reports an island manifest ONLY
    // when the route uses <Island>; `"[]"` ⇒ no islands ⇒ leave the .jinja
    // byte-identical (no-island regression). Remove any stale sibling so a
    // route that dropped its islands doesn't reconcile against an old manifest.
    const islandsJsonPath = resolve(opts.outDir, `${name}.islands.json`)
    if (compiled.islandsJson && compiled.islandsJson !== '[]') {
      writeFileSync(islandsJsonPath, compiled.islandsJson)
      reconcileIslandManifest(outPath, islandsJsonPath, mergedImports, name)
      outputs.push(islandsJsonPath)
    } else if (existsSync(islandsJsonPath)) {
      rmSync(islandsJsonPath, { force: true })
    }

    // SSR component artifacts: .components.json + .factory.ts
    const compJsonStr = (compiled as any).componentsJson ?? '[]'
    if (compJsonStr !== '[]') {
      emitComponentArtifacts(outPath, compJsonStr, mergedImports, name)
      outputs.push(
        outPath.replace(/\.jinja$/, '.components.json'),
        outPath.replace(/\.jinja$/, '.factory.ts'),
      )
    }

    // R14 — memoize only what was hashed AND written by an incremental call;
    // a non-incremental compile (build/boot) invalidates the entry instead
    // (its writes weren't checked against any hash → never trust-skip them).
    if (opts.incremental && inputsHash !== undefined) {
      nativeEmitMemo.set(memoKey, { hash: inputsHash, outputs })
    } else {
      nativeEmitMemo.delete(memoKey)
    }
  }

  writeFileSync(
    resolve(opts.outDir, '_manifest.json'),
    JSON.stringify({ templates: built, generatedAt: new Date().toISOString() }, null, 2),
  )

  if (opts.incremental && nativeRoutes.length > 0) {
    console.log(
      `[brust] dev: native templates — ${stats.compiled} compiled, ${stats.skipped} unchanged (skipped)`,
    )
  }
  return stats
}

/** A JSX SSR-component ident is always Capitalized — `<Search/>` lowers to an
 * SsrComponent while `<search/>` is a host element. The Rust compiler only lists
 * Capitalized idents in `componentsJson`/`islandsJson`, so only Capitalized
 * idents can collide as ambiguous COMPONENT sources. Lowercase idents (hooks,
 * store singletons like `teamStore`, util fns) are never components — two local
 * files legitimately sharing such a name (e.g. `teamStore` from two stores) must
 * NOT trip the component-ambiguity guard. (Pre-`scanImportRefs`, the
 * default-only scanner never saw named/namespace lowercase imports at all.) */
function isComponentIdent(ident: string): boolean {
  return /^[A-Z]/.test(ident)
}

/** A resolved import reference, capturing the import FORM so the SSR factory can
 * regenerate the correct `import` statement. Used only by the SSR-component path
 * (`gatherComponentSources`/`gatherChainSources` → `emitComponentArtifacts` /
 * `reconcileIslandManifest`), NOT by `scanImports` (which stays local-default
 * string-valued for the two external callers in islands/native build). */
export interface ResolvedImport {
  /** Module specifier: an ABSOLUTE file path for local imports, or the verbatim
   * bare specifier for package imports. */
  spec: string
  /** true ⇒ `spec` is a package/bare specifier (keep verbatim; do not
   * readFileSync/relativize/recurse). */
  bare: boolean
  /** How the symbol was imported, so the factory regenerates the right import. */
  kind: 'default' | 'named' | 'namespace'
  /** For `named`, the exported name (may differ from the local alias). */
  imported?: string
}

/** Resolve a module specifier as it appears in an import: a `.`/`..`-prefixed
 * (local) spec resolves to an absolute file path via the `.tsx/.ts/index.*`
 * candidate logic; any other (bare/package) spec is kept verbatim. Returns
 * `undefined` for a local spec that resolves to no existing file (matches
 * scanImports' silent-drop behavior). */
function resolveSpec(spec: string, fromFile: string): ResolvedImport | undefined {
  if (!spec.startsWith('.')) {
    // Package/bare specifier — keep verbatim, never resolve/readFileSync.
    return { spec, bare: true, kind: 'default' }
  }
  const baseDir = dirname(fromFile)
  const resolved = resolve(baseDir, spec)
  const candidates = [
    `${resolved}.tsx`,
    `${resolved}.ts`,
    `${resolved}/index.tsx`,
    `${resolved}/index.ts`,
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) return undefined
  return { spec: found, bare: false, kind: 'default' }
}

/** Scan ALL import forms in `file` and resolve each local-name binding to a
 * {@link ResolvedImport}. Unlike {@link scanImports} (default-local only, kept
 * stable for external callers), this:
 * - parses default / `* as ns` / `{ a, b as c }` / mixed `d, { a }` forms;
 * - keeps package/bare specifiers verbatim (`bare:true`) instead of skipping
 *   them — the SSR path needs them to regenerate `import` lines and to SSR
 *   third-party components (e.g. lucide-react icons).
 *
 * Returns `Map<localName, ResolvedImport>` (localName = the in-source identifier
 * used in JSX). Namespace imports are recorded parse-only (the Rust compiler
 * rejects member-expression elements, so `<Ns.Member/>` isn't renderable yet). */
export function scanImportRefs(file: string): Map<string, ResolvedImport> {
  const source = readFileSync(file, 'utf8')
  const map = new Map<string, ResolvedImport>()
  // Match any import statement's clause + specifier. The clause is parsed below.
  const re = /^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/gm
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const clause = m[1]!.trim()
    // `import type …` / `import type { … }` / `import type * as …` are erased at
    // build — they bind no runtime value, so a type alias must never enter the
    // map (a Capitalized type name could otherwise collide with a real component).
    if (/^type[\s{*]/.test(clause)) continue
    const spec = m[2]!
    const resolved = resolveSpec(spec, file)
    if (!resolved) continue // local spec that resolves to no file — silent drop

    // Namespace: `* as Ns`
    const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause)
    if (nsMatch) {
      map.set(nsMatch[1]!, { ...resolved, kind: 'namespace' })
      continue
    }

    // Split a possible mixed clause `Default, { a, b as c }` into default +
    // named parts. The default ident (if any) is the leading bare identifier.
    const rest = clause
    const namedStart = rest.indexOf('{')
    let defaultPart = namedStart === -1 ? rest : rest.slice(0, namedStart)
    defaultPart = defaultPart.replace(/,\s*$/, '').trim()
    if (defaultPart) {
      const defMatch = /^([A-Za-z_$][\w$]*)$/.exec(defaultPart)
      if (defMatch) {
        map.set(defMatch[1]!, { ...resolved, kind: 'default' })
      }
    }

    if (namedStart !== -1) {
      const namedEnd = rest.indexOf('}', namedStart)
      const inner = rest.slice(namedStart + 1, namedEnd === -1 ? undefined : namedEnd)
      for (const raw of inner.split(',')) {
        const piece = raw.trim()
        if (!piece) continue
        const aliasMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(piece)
        if (aliasMatch) {
          map.set(aliasMatch[2]!, { ...resolved, kind: 'named', imported: aliasMatch[1]! })
        } else if (/^[A-Za-z_$][\w$]*$/.test(piece)) {
          map.set(piece, { ...resolved, kind: 'named', imported: piece })
        }
      }
    }
  }
  return map
}

/** Convert a PascalCase/camelCase identifier to kebab-case
 * (`ChevronRight` → `chevron-right`). Used to map a lucide icon's exported
 * name to its per-icon ESM module filename. */
function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

const requireFromHere = createRequire(import.meta.url)

/** Follow a lucide-react alias module to its canonical icon. ~249 icons (e.g.
 * `arrow-down-az`) ship as a re-export STUB — `export { default } from
 * './arrow-down-a-z.mjs'` — that carries NO `__iconNode` (the data lives in the
 * canonical file, which lucide kebabs differently for consecutive capitals:
 * `ArrowDownAZ` → `arrow-down-az` here vs `arrow-down-a-z` on disk). Read the
 * stub's source and return the canonical kebab, or `null` if `<kebab>.mjs` is not
 * an alias stub (i.e. already canonical / unresolvable). */
function followLucideAlias(kebab: string): string | null {
  try {
    const src = readFileSync(
      requireFromHere.resolve(`lucide-react/dist/esm/icons/${kebab}.mjs`),
      'utf8',
    )
    const m = src.match(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\/(.+?)\.mjs['"]/)
    return m ? m[1]! : null
  } catch {
    return null
  }
}

/** Extract static SVG node data for every `lucide-react` icon imported by
 * `file`, keyed by its in-source local name.
 *
 * For each lucide import (`entry.bare && entry.spec === 'lucide-react'`), the
 * icon's exported name (`imported` for named/aliased, the local name for a
 * default import) is kebab-cased to locate `lucide-react/dist/esm/icons/
 * <kebab>.mjs`, whose `__iconNode` array is reshaped into the JSON the Rust
 * compiler deserializes: `{ cls, node: [[tag, [[attr,val],…]], …] }`. The
 * lucide-internal `key` attr is stripped and all attr values are coerced to
 * strings. An unresolvable icon name is silently omitted. */
export async function extractLucideIcons(file: string): Promise<Record<string, string>> {
  const refs = scanImportRefs(file)
  const out: Record<string, string> = {}
  for (const [local, entry] of refs) {
    if (!entry.bare || entry.spec !== 'lucide-react') continue
    const pascal = entry.imported ?? local // default import → local name
    let kebab = toKebabCase(pascal)
    try {
      let mod = await import(`lucide-react/dist/esm/icons/${kebab}.mjs`)
      let iconNode = mod.__iconNode
      if (!Array.isArray(iconNode)) {
        // Re-export alias stub (no __iconNode) → follow to the canonical icon
        // file, and use ITS kebab for both the import and the `cls`.
        const canonical = followLucideAlias(kebab)
        if (canonical) {
          mod = await import(`lucide-react/dist/esm/icons/${canonical}.mjs`)
          iconNode = mod.__iconNode
          kebab = canonical
        }
      }
      if (!Array.isArray(iconNode)) continue
      const node = iconNode.map(([tag, attrs]: [string, Record<string, unknown>]) => {
        const pairs: [string, string][] = []
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'key') continue
          pairs.push([k, String(v)])
        }
        return [tag, pairs]
      })
      out[local] = JSON.stringify({ cls: `lucide lucide-${kebab}`, node })
    } catch {
      // unresolvable icon name → omit (graceful)
    }
  }
  return out
}

/** Scan the entry file's `import Name from './path'` declarations and build a
 * map of localName -> resolved absolute path (DEFAULT-LOCAL only — package
 * specifiers skipped). Extension resolution tries `.tsx`, `.ts`, `/index.tsx`,
 * `/index.ts` in order. Kept string-valued + default-local for the external
 * callers in islands/build.ts + native/build.ts; the SSR-component path uses the
 * richer {@link scanImportRefs} instead. */
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
 *    boot-time compile. The md emit step passes `bakeBootstrap: false` and bakes
 *    once itself at the END of its pipeline (the append here has no `includes()`
 *    guard, so a second pass over the same template would double-bake).
 */
export function reconcileIslandManifest(
  jinjaPath: string,
  islandsJsonPath: string,
  pageImports: Map<string, ResolvedImport>,
  routeName: string,
  options?: { bakeBootstrap?: boolean },
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
    const ref = pageImports.get(entry.component)
    if (!ref) {
      throw new Error(
        `island component "${entry.component}" in native route "${routeName}" has no matching import in the page source (expected \`import ${entry.component} from "..."\`)`,
      )
    }
    // Islands are LOCAL-only: the runtime (`loadIslandManifest`) rehydrates
    // sourcePath against cwd, so a bare/package spec would break hydration. A
    // bare-import island is a hard error, not a silently-written bad manifest.
    if (ref.bare) {
      throw new Error(
        `island component "${entry.component}" in native route "${routeName}" resolves to a bare/package import "${ref.spec}" — islands must be imported from a local file (the manifest's sourcePath is rehydrated against cwd at runtime)`,
      )
    }
    return { ...entry, sourcePath: relative(projectRoot, ref.spec).replaceAll('\\', '/') }
  })

  writeFileSync(islandsJsonPath, JSON.stringify(enriched))

  // Rewrite each marker's id from the plain component name to the
  // content-addressed unique id (`<Name>_<hash(sourcePath)>`) — same id the
  // chunk filename + the bootstrap use — so two same-name islands from different
  // files get distinct markers → distinct chunks. Keyed by instance (the
  // data-brust-props var carries it); the marker format is compiler-emitted and
  // stable (see emit_jinja.rs).
  const idByInstance = new Map<number, string>()
  for (const e of enriched) {
    const ref = pageImports.get(e.component)
    if (ref) idByInstance.set(e.instance, islandChunkBasename(e.component, ref.spec))
  }
  let jinja = readFileSync(jinjaPath, 'utf8')
  jinja = jinja.replace(
    /data-brust-island="[^"]*"(\s+data-brust-props="\{\{ island_(\d+)_props \}\}")/g,
    (whole, rest: string, nStr: string) => {
      const id = idByInstance.get(Number(nStr))
      return id ? `data-brust-island="${id}"${rest}` : whole
    },
  )

  if (options?.bakeBootstrap === false) {
    writeFileSync(jinjaPath, jinja)
    return
  }
  const baked = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
  writeFileSync(jinjaPath, jinja + baked)
}
