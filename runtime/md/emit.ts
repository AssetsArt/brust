// Task 2.7 — the md emit step. Per markdown route: render the md body to
// jinja-safe HTML (render.ts), compile a synthetic wrapper TSX through the
// SAME napi `compileJsx` the native pipeline uses, splice the md HTML into the
// compiled template's slot element, merge the island manifest, and bake the
// client runtime tags in a SINGLE idempotent pass.
//
// Pinned order of operations (spec §High-level architecture step 6):
//   compileJsx(wrapper) → splice md HTML → merge manifest → single bake pass.
//
// No Rust changes: the integration points are jinja text files and
// `.islands.json` sidecars, both already consumed by the existing pipeline.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { insertGeneratorMeta, resolveGenerator } from '../generator.ts'
import {
  bakeDirectivesIfUsed,
  buildChainWrapperSource,
  cleanupComponentArtifacts,
  countMainTags,
  emitComponentArtifacts,
  extractLucideIcons,
  gatherChainSources,
  injectDevClientIntoTemplate,
  type ResolvedImport,
  reconcileIslandManifest,
  scanImports,
} from '../cli/native-routes-emit.ts'
import { islandChunkBasename } from '../islands/chunk-id.ts'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
import type { NativeIslandEntry } from '../islands/native-render.ts'
import { directiveName, isBehaviorSource, scanDirectiveComponents } from '../native/build.ts'
import { type MdBehaviorUse, type MdComponentResolution, renderMdPage } from './render.ts'
import { type MdRouteSource, mdManifestFromFlatRoutes, writeMdManifest } from './routes.ts'
import { type MdFile, scanMdDir } from './scan.ts'

/** The slice of a FlatRoute the md emit step reads. The chain holds the route
 * NODES, so the md leaf's `__mdSource` (runtime/md/routes.ts) survives into it.
 * `fullPath` is only read by the manifest derivation (emitMdArtifacts).
 * `Component` admits plain `{ name }` carriers AND real component values
 * (function/class — both expose `.name` via the Function prototype), so a
 * `FlatRoute[]` passes without casts. */
export interface FlatRouteLike {
  fullPath?: string
  nativeTemplate?: string
  chain?: Array<{
    Component?:
      | { name?: string }
      | ((...args: never[]) => unknown)
      | (abstract new (
          ...args: never[]
        ) => unknown)
    __mdSource?: MdRouteSource
  }>
}

export interface MdEmitOpts {
  /** User's routes entry file (absolute path) — scanned for the default-import
   * idents that resolve embedded component tags, and for app-wide directives. */
  entryFile: string
  /** Flat routes; only chains whose LEAF carries `__mdSource` are emitted. */
  flatRoutes: FlatRouteLike[]
  /** Jinja output dir (same dir `emitNativeTemplates` writes to). */
  outDir: string
  /** Bake the /_brust/dev WS client tag (parity with the native emit's
   * BRUST_DEV injection — md pages render Rust-side and never pass through the
   * React renderer's dev-client injection). */
  withDevClient?: boolean
  /** What to do when a route's md file no longer exists on disk (deleted after
   * the route table was built). emitMdTemplates serves BOTH `brust build` and
   * the dev re-emit, and the two must diverge here:
   *   - `'throw'` (build): a missing file is a HARD error — silently skipping
   *     ships a dist with the route registered but its template absent.
   *   - `'skip-warn'` (default; dev boot/re-emit): skip the route and warn
   *     once that a restart is required — the dev route table is frozen at
   *     boot, so a crash here would take down the whole hot-reload loop. */
  onMissing?: 'throw' | 'skip-warn'
}

// Once-per-process flag for the add/remove warning: every re-emit (HMR fires
// on each md edit) would otherwise repeat it.
let mdRoutesChangedWarned = false

function warnMdRoutesChanged(): void {
  if (mdRoutesChangedWarned) return
  mdRoutesChangedWarned = true
  console.warn('[brust dev] md routes changed — restart required')
}

/** Test helper. */
export function _resetMdRoutesChangedWarnForTests(): void {
  mdRoutesChangedWarned = false
}

/** Raw island entry as the Rust compiler emits it (camelCase JSON). */
interface RawIslandEntry {
  component: string
  instance: number
  propsPath: string
  ssr: boolean
  hydrate: string
}

/** Minimal shape of the napi addon's `compileJsx`. */
type CompileJsx = (
  source: string,
  path: string,
  componentSources?: Record<string, string>,
  lucideIcons?: Record<string, string>,
  directiveNames?: Record<string, string>,
) => { template: string; islandsJson: string; componentsJson?: string; warnings?: string[] }

/** Emit one `.jinja` (+ `.islands.json` sidecar) per md route in `flatRoutes`.
 * Returns the islands referenced from md content (`name → absolute source
 * path`) so the build step can thread them into island-chunk discovery as
 * `extraIslands` (task 2.8). Behaviors are NOT in the map — their chunks are
 * built by `scanDirectiveComponents`, which already walks the routes-entry
 * import graph the registry keeps alive. */
export async function emitMdTemplates(opts: MdEmitOpts): Promise<{
  mdIslands: Map<string, string>
}> {
  const mdIslands = new Map<string, string>()
  const mdRoutes = opts.flatRoutes.filter(
    (r) => r.nativeTemplate && r.chain?.[r.chain.length - 1]?.__mdSource,
  )
  if (mdRoutes.length === 0) return { mdIslands }

  mkdirSync(opts.outDir, { recursive: true })

  // Same dynamic-import seam as emitNativeTemplates: the napi addon ships
  // compileJsx with every platform package.
  const native = await import('../index.js')
  const compileJsx = (native as { compileJsx?: CompileJsx }).compileJsx
  if (typeof compileJsx !== 'function') {
    throw new Error(
      'brust: the native addon does not expose compileJsx — rebuild it with ' +
        '`cd runtime && bun run build` (or update brustjs to a build that ships it).',
    )
  }

  const projectRoot = process.cwd()
  const importMap = scanImports(opts.entryFile)
  // App-wide directive presence — same force rule as emitNativeTemplates: SPA
  // nav swaps <main> without executing scripts, so the directive runtime must
  // already be live on every native page when ANY directive component exists.
  const hasDirectives = scanDirectiveComponents(opts.entryFile).size > 0

  // Add/remove detection (task 2.9): the dev route table is frozen at boot,
  // so a created/deleted .md file can't become/stop being a route until the
  // dev process restarts. Compare the scanned set against the route set per
  // content dir and tell the operator ONCE — never crash the re-emit.
  const routeRelsByDir = new Map<string, Set<string>>()
  for (const r of mdRoutes) {
    const src = (r.chain as NonNullable<FlatRouteLike['chain']>)[r.chain!.length - 1]
      ?.__mdSource as MdRouteSource
    let rels = routeRelsByDir.get(src.contentDir)
    if (rels === undefined) {
      rels = new Set()
      routeRelsByDir.set(src.contentDir, rels)
    }
    rels.add(src.relPath)
  }

  // One scan per content dir (md bodies aren't carried on __mdSource).
  const onMissing = opts.onMissing ?? 'skip-warn'
  const mdFilesByDir = new Map<string, Map<string, MdFile>>()
  const mdFileFor = (src: MdRouteSource): MdFile | undefined => {
    let files = mdFilesByDir.get(src.contentDir)
    if (files === undefined) {
      files = new Map(scanMdDir(src.contentDir).map((f) => [f.relPath, f]))
      mdFilesByDir.set(src.contentDir, files)
      const rels = routeRelsByDir.get(src.contentDir) as Set<string>
      const setsMatch = files.size === rels.size && [...rels].every((rel) => files!.has(rel))
      // The "restart required" phrasing only makes sense in dev: in build mode
      // a missing file throws below instead (an extra file is harmless — the
      // build's freshly loaded route table simply doesn't reference it).
      if (!setsMatch && onMissing === 'skip-warn') warnMdRoutesChanged()
    }
    return files.get(src.relPath)
  }

  // Generator meta: resolved INTERNALLY from the out dir's artifact (NOT a
  // caller param) — emit re-runs from five call sites (build, dev, boot
  // staleness, md boot re-emit, dev HMR) and a param would silently drop the
  // tag on re-emit. Fallback (no artifact) = version-on defaults.
  const generatorMeta = resolveGenerator(opts.outDir).meta

  // Tag-name → classification, shared across pages (one readFileSync per name).
  const resolutionCache = new Map<string, { res: MdComponentResolution; absPath: string }>()

  for (const r of mdRoutes) {
    const name = r.nativeTemplate as string
    const chain = r.chain as NonNullable<FlatRouteLike['chain']>
    const src = chain[chain.length - 1]?.__mdSource as MdRouteSource
    const mdFile = mdFileFor(src)
    if (mdFile === undefined) {
      if (onMissing === 'throw') {
        // Build mode: the route is registered but its markdown source is gone —
        // emitting nothing would ship an incomplete dist (template absent).
        throw new Error(
          `md route "${r.fullPath ?? name}" references ${src.absPath}, but the markdown ` +
            'file no longer exists — delete the route or restore the file, then rebuild',
        )
      }
      // Dev: a removed file is skipped (its stale template keeps serving until
      // the restart the once-warn in mdFileFor asked for); the emit proceeds.
      continue
    }

    // 1. Resolver: registry key → routes-entry default import → island/behavior.
    const resolve = (tag: string, line: number): MdComponentResolution | null => {
      if (!Object.hasOwn(src.components, tag)) return null // unknown → render.ts errors
      let cached = resolutionCache.get(tag)
      if (cached === undefined) {
        const absPath = importMap.get(tag)
        if (absPath === undefined) {
          // All THREE identities must coincide: the md tag name, the mdRoutes
          // components-registry key, and the routes-entry default-import ident.
          throw new Error(
            `${src.absPath}:${line} — <${tag}> is in the mdRoutes components registry, but the ` +
              `routes entry (${opts.entryFile}) has no matching default import ` +
              `(expected \`import ${tag} from "..."\`). The md tag name, the registry key, ` +
              `and the routes-entry import ident must all be the same name.`,
          )
        }
        const res: MdComponentResolution = isBehaviorSource(readFileSync(absPath, 'utf8'))
          ? { kind: 'behavior', directive: directiveName(absPath, projectRoot) }
          : { kind: 'island', id: islandChunkBasename(tag, absPath) }
        cached = { res, absPath }
        resolutionCache.set(tag, cached)
      }
      if (cached.res.kind === 'island') mdIslands.set(tag, cached.absPath)
      return cached.res
    }

    // 2. md → jinja-safe HTML with LIVE island/behavior host markers
    //    (LOCAL instance numbers — offset below).
    const rendered = await renderMdPage({ body: mdFile.body, absPath: src.absPath, resolve })

    // 3. Wrapper TSX (in-memory — compileJsx keys off the default export +
    //    componentSources; routeSourcePath need not exist on disk).
    let routeSource: string
    let routeSourcePath: string
    let sources: Record<string, string>
    let mergedImports: Map<string, ResolvedImport>
    if (chain.length > 1) {
      // Chained: bare <article> fragment composed via the EXISTING chain path —
      // the synthetic leaf source is injected next to the gathered chain sources.
      const ancestorNames = chain
        .slice(0, -1)
        .map((node) => node.Component?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
      if (ancestorNames.length !== chain.length - 1) {
        throw new Error(
          `md route "${name}" (${src.absPath}) has an unnamed layout component in its chain — every chain level needs a named component`,
        )
      }
      ;({ sources, mergedImports } = gatherChainSources(ancestorNames, importMap))
      sources[name] = mdChainedLeafSource(name)
      routeSource = buildChainWrapperSource([...ancestorNames, name])
      const firstAncestorPath = importMap.get(ancestorNames[0] as string) as string
      routeSourcePath = path.resolve(path.dirname(firstAncestorPath), `${name}__chain.tsx`)
    } else {
      // Standalone: the wrapper owns the <BrustPage> shell; frontmatter
      // title/description become literal props.
      sources = {}
      mergedImports = new Map()
      routeSource = mdStandaloneSource(name, src.frontmatter)
      routeSourcePath = path.resolve(src.contentDir, `${name}.tsx`)
    }

    // Lucide + directive maps for inlined chain components — mirrors
    // emitNativeTemplates (the wrapper itself can't carry either).
    const lucideIcons: Record<string, string> = {}
    for (const imp of mergedImports.values()) {
      if (!imp.bare && typeof imp.spec === 'string') {
        Object.assign(lucideIcons, await extractLucideIcons(imp.spec))
      }
    }
    const directiveNames: Record<string, string> = {}
    for (const [ident, text] of Object.entries(sources)) {
      if (!isBehaviorSource(text)) continue
      const ref = mergedImports.get(ident)
      if (ref && !ref.bare && typeof ref.spec === 'string') {
        directiveNames[ident] = directiveName(ref.spec, projectRoot)
      }
    }

    let compiled: ReturnType<CompileJsx>
    try {
      compiled = compileJsx(routeSource, routeSourcePath, sources, lucideIcons, directiveNames)
    } catch (e) {
      throw new Error(
        `md route "${name}" wrapper failed to compile (${src.absPath}):\n${String(e)}`,
      )
    }
    for (const w of compiled.warnings ?? []) process.stderr.write(`brust: ${w}\n`)

    // 4. Offset md island instances past the wrapper/layout TSX islands, then
    //    splice. Single-pass regex — no replace cascade when offset overlaps
    //    the local range. The md HTML is already brace-neutralized with LIVE
    //    markers (render.ts), so it is NOT re-neutralized here.
    const tsxIslands = JSON.parse(
      compiled.islandsJson === '' ? '[]' : compiled.islandsJson,
    ) as RawIslandEntry[]
    const offset = tsxIslands.length > 0 ? Math.max(...tsxIslands.map((e) => e.instance)) + 1 : 0
    let mdHtml = rendered.html
    if (offset > 0 && rendered.islands.length > 0) {
      // Anchored on the LIVE-jinja prefix `{{ island_`: after neutralizeBraces
      // every literal `{{` in md content reads `{{ "{{" }}` (next char `"`),
      // so this byte sequence exists ONLY in the injected host markers — prose
      // or code fences that mention island_N_props are never touched. (Same
      // anchoring discipline as reconcileIslandManifest's marker rewrite.)
      mdHtml = mdHtml.replace(
        /\{\{ island_(\d+)_(props|html)/g,
        (_m, n: string, kind: string) => `{{ island_${Number(n) + offset}_${kind}`,
      )
    }

    // 4b. Behavior hosts: render.ts emitted a unique nonce-bearing placeholder
    //     per use (it has no compileJsx access — this module does). Compile
    //     each behavior component's BODY through the SAME native-inline path a
    //     TSX page uses and substitute the fully inlined markup whole-tag over
    //     the placeholder. A bare x-data div would have no children → no
    //     x-on-* click targets → the behavior could never do anything.
    for (const [i, use] of rendered.behaviors.entries()) {
      const absPath = (resolutionCache.get(use.name) as { absPath: string }).absPath
      const inlined = await compileMdBehaviorHost(compileJsx, use, absPath, src.absPath, i)
      const at = mdHtml.indexOf(use.marker)
      if (at === -1 || mdHtml.indexOf(use.marker, at + 1) !== -1) {
        throw new Error(
          `md route "${name}": behavior placeholder for <${use.name}> (${src.absPath}:${use.line}) ` +
            'is not exactly-once in the rendered HTML — emit-pipeline invariant violated',
        )
      }
      mdHtml = mdHtml.slice(0, at) + inlined + mdHtml.slice(at + use.marker.length)
    }

    const template = insertGeneratorMeta(
      spliceMdSlot(compiled.template, name, mdHtml),
      generatorMeta,
    )
    if (countMainTags(template) > 1) {
      process.stderr.write(
        `brust: md route "${name}" has more than one <main> after splice — SPA navigation extracts only the first <main>…</main>.\n`,
      )
    }
    const outPath = path.resolve(opts.outDir, `${name}.jinja`)
    writeFileSync(outPath, template)

    // 5. Manifest merge: reconcile the compiler's TSX entries (sourcePath
    //    enrichment + content-addressed marker-id rewrite — md markers carry
    //    offset instances the rewrite map doesn't know, so they pass through
    //    untouched), then append the md entries.
    const islandsJsonPath = path.resolve(opts.outDir, `${name}.islands.json`)
    if (tsxIslands.length > 0) {
      writeFileSync(islandsJsonPath, compiled.islandsJson)
      reconcileIslandManifest(outPath, islandsJsonPath, mergedImports, name, {
        bakeBootstrap: false,
      })
    } else if (existsSync(islandsJsonPath)) {
      rmSync(islandsJsonPath, { force: true }) // stale sidecar from a previous emit
    }
    const mdEntries: NativeIslandEntry[] = rendered.islands.map((use) => {
      const absPath = (resolutionCache.get(use.name) as { absPath: string }).absPath
      return {
        component: use.name,
        instance: use.instanceLocal + offset,
        propsPath: '',
        propsLiteral: use.props,
        ssr: !use.csr,
        hydrate: use.hydrate,
        sourcePath: path.relative(projectRoot, absPath).replaceAll('\\', '/'),
      }
    })
    if (mdEntries.length > 0) {
      const existing =
        tsxIslands.length > 0
          ? (JSON.parse(readFileSync(islandsJsonPath, 'utf8')) as NativeIslandEntry[])
          : []
      writeFileSync(islandsJsonPath, JSON.stringify([...existing, ...mdEntries]))
    }

    // SSR-component sidecars (chained layouts can carry SSR components).
    const compJsonStr = compiled.componentsJson ?? '[]'
    if (compJsonStr !== '[]') {
      emitComponentArtifacts(outPath, compJsonStr, mergedImports, name)
    } else {
      cleanupComponentArtifacts(outPath, name)
    }

    // 6. Single idempotent bake pass. Every append below is `includes()`-guarded
    //    (reconcile's unguarded bake was skipped above), so re-running emit —
    //    or emitComponentArtifacts having baked the bootstrap already — can
    //    never double-bake.
    let final = readFileSync(outPath, 'utf8')
    if (tsxIslands.length > 0 || mdEntries.length > 0) {
      const baked = `{% raw %}${ISLANDS_IMPORTMAP_AND_BOOTSTRAP}{% endraw %}`
      if (!final.includes(baked)) final += baked
    }
    final = bakeDirectivesIfUsed(final, hasDirectives)
    if (opts.withDevClient) final = injectDevClientIntoTemplate(final)
    writeFileSync(outPath, final)
  }

  return { mdIslands }
}

export interface MdArtifactsOpts extends MdEmitOpts {
  /** Dirs to write `md-manifest.json` into when the app has md routes (e.g.
   * `<distDir>` and `<cwd>/.brust` — both "next to" their jinja dirs, where
   * `loadPrebuiltMdManifest` / the staleness check look). Skipped entirely
   * when there are no md routes (zero output difference for md-free apps). */
  manifestDirs?: string[]
}

/** Task 2.8 build-integration seam: emit the md `.jinja` templates AND the
 * frozen `md-manifest.json` (derived from the same flat route table — single
 * source of truth) in one call. All build sites (`brust build`, `brust dev`
 * boot/re-emit, runtime boot, dev HMR island rebuild) go through this so the
 * template, manifest, and returned `mdIslands` chunk inputs can never diverge.
 * Strict no-op for apps without md routes. */
export async function emitMdArtifacts(opts: MdArtifactsOpts): Promise<{
  mdIslands: Map<string, string>
}> {
  const { mdIslands } = await emitMdTemplates(opts)
  const manifest = mdManifestFromFlatRoutes(opts.flatRoutes)
  if (manifest !== null) {
    for (const d of opts.manifestDirs ?? []) {
      writeMdManifest(d, manifest.entries, manifest.contentDir)
    }
  }
  return { mdIslands }
}

/** Standalone wrapper: the md page owns the document shell. Frontmatter
 * title/description thread in as literal BrustPage props — JSON.stringify
 * yields a valid JS string literal for the JSX expression container, so
 * quotes/backslashes/newlines in frontmatter can't break the synthetic source. */
function mdStandaloneSource(name: string, frontmatter: MdRouteSource['frontmatter']): string {
  const title =
    typeof frontmatter.title === 'string' ? ` title={${JSON.stringify(frontmatter.title)}}` : ''
  const description =
    typeof frontmatter.description === 'string'
      ? ` description={${JSON.stringify(frontmatter.description)}}`
      : ''
  return `export default function ${name}() { return <BrustPage${title}${description}><main data-brust-md-slot="${name}"></main></BrustPage>; }`
}

/** Compile one md behavior use into its fully inlined host markup.
 *
 * A synthetic wrapper (`<Name native …/>`) goes through the SAME `compileJsx`
 * napi call as TSX pages, with the component source + the canonical directive
 * name threaded exactly like emitNativeTemplates does (componentSources + the
 * 5th `directiveNames` arg — that arg is what makes the compiler auto-inject
 * `x-data="<directive>"` onto the inlined root). md tag props are literals,
 * validated string/number in render.ts; both are passed as JS STRING literal
 * expression containers (`label={"…"}`):
 *   - strings inline-substitute fully static WITH proper HTML escaping
 *     (verified empirically — plain `p="…"` attrs can't carry quotes, and
 *     bare `n={42}` leaves live `{{ (42) | e }}` jinja in the template);
 *   - numbers stringify output-equivalently (the body renders them as text,
 *     and the inline path rejects arithmetic anyway).
 *
 * The result must be FULLY STATIC: any remaining `{{` means the body
 * references something non-literal (a prop the tag didn't pass, route data,
 * an island, an SSR component) → hard build error. Literal-only control flow
 * (`{% if "yes" %}`) is allowed through — it renders correctly when the page
 * template passes through minijinja. */
async function compileMdBehaviorHost(
  compileJsx: CompileJsx,
  use: MdBehaviorUse,
  componentPath: string,
  mdAbsPath: string,
  index: number,
): Promise<string> {
  const attrs = Object.entries(use.props)
    .map(([k, v]) => ` ${k}={${JSON.stringify(String(v))}}`)
    .join('')
  const wrapperSource = `export default function MdBehaviorHost_${index}() { return <${use.name} native${attrs} /> }`
  // Synthetic path — compileJsx keys off the default export + componentSources.
  const wrapperPath = path.resolve(path.dirname(componentPath), `__MdBehaviorHost_${index}.tsx`)
  // The behavior component's own file may import lucide icons (they become
  // static SVG in native-inlined bodies) — same extraction as the chain path.
  const lucideIcons = await extractLucideIcons(componentPath)

  let compiled: ReturnType<CompileJsx>
  try {
    compiled = compileJsx(
      wrapperSource,
      wrapperPath,
      { [use.name]: readFileSync(componentPath, 'utf8') },
      lucideIcons,
      { [use.name]: use.directive },
    )
  } catch (e) {
    throw new Error(
      `${mdAbsPath}:${use.line} — <${use.name}> failed to compile as an inlined md behavior host:\n${String(e)}`,
    )
  }
  for (const w of compiled.warnings ?? []) process.stderr.write(`brust: ${w}\n`)

  if (compiled.template.includes('{{')) {
    throw new Error(
      `${mdAbsPath}:${use.line} — <${use.name}> body references non-literal data; ` +
        'md behavior components must be fully static (every value the body renders ' +
        'must come from a literal prop on the md tag)',
    )
  }
  if (!compiled.template.includes(`x-data="${use.directive}"`)) {
    // Auto-injection puts the canonical directive name on the inlined root; a
    // literal author x-data would win over it and desync from the built
    // `<directive>.directive.js` chunk this md use was resolved against.
    throw new Error(
      `${mdAbsPath}:${use.line} — <${use.name}> compiled without x-data="${use.directive}" on its ` +
        'root element (a literal x-data override on the component root is not supported in md)',
    )
  }
  return compiled.template
}

/** Chained leaf wrapper: a bare fragment — the layout owns the document shell
 * and the single <main> (a nested <main> truncates SPA-nav payloads; a nested
 * BrustPage emits a nested <html> document). */
function mdChainedLeafSource(name: string): string {
  return `export default function ${name}() { return <article data-brust-md-slot="${name}"></article>; }`
}

/** Replace the slot element's inner content with the md HTML. The slot attr
 * itself stays (hydration-neutral, useful for tests). Exactly one slot must
 * exist and it must be empty — both are emit-pipeline invariants, so a
 * violation is a hard error, not a soft skip. `name` is a generated template
 * name (`[A-Za-z0-9_]` only), so interpolating it into the regex is safe. */
export function spliceMdSlot(template: string, name: string, mdHtml: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`md route template name "${name}" is not a valid generated name`)
  }
  // The JSX compiler emits paired tags for empty elements (<main></main>,
  // never <main/>) — HTML output, not XML. The empty-slot check below relies
  // on that contract.
  const openRe = new RegExp(`<(main|article)\\b[^>]*\\bdata-brust-md-slot="${name}"[^>]*>`, 'g')
  const matches = [...template.matchAll(openRe)]
  if (matches.length !== 1) {
    throw new Error(
      `md route "${name}": expected exactly one data-brust-md-slot="${name}" element in the compiled template, found ${matches.length}`,
    )
  }
  const m = matches[0] as RegExpMatchArray & { index: number }
  const insertAt = m.index + m[0].length
  const closeTag = `</${m[1]}>`
  if (!template.startsWith(closeTag, insertAt)) {
    throw new Error(
      `md route "${name}": the data-brust-md-slot element must compile empty (expected ${closeTag} immediately after the open tag)`,
    )
  }
  return template.slice(0, insertAt) + mdHtml + template.slice(insertAt)
}
