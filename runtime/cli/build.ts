import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path, { isAbsolute, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import { emitNativeTemplates } from './native-routes-emit.ts'
import { nativeShimPlugin } from './native-shim-plugin.ts'

/** repoRoot = the directory that contains runtime/. This file lives at
 * runtime/cli/build.ts so two dirname() steps get us there. */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

/** Detect musl (mirrors the napi loader + native-shim) so we pick the right
 * platform package on Linux. */
function linuxIsMusl(): boolean {
  try {
    const report = process.report as { excludeNetwork?: boolean; getReport?: () => unknown }
    if (report && typeof report.getReport === 'function') {
      report.excludeNetwork = true
      const r = report.getReport() as { header?: { glibcVersionRuntime?: string } }
      return !r?.header?.glibcVersionRuntime
    }
  } catch {}
  return false
}

/** The npm package that carries this platform's prebuilt binary. */
function platformPackageName(): string {
  const { platform, arch } = process
  if (platform === 'linux') return `brustjs-linux-${arch}-${linuxIsMusl() ? 'musl' : 'gnu'}`
  return `brustjs-${platform}-${arch}`
}

/** Absolute paths of every `brust.*.node` to copy into the dist. Source-tree /
 * CI-matrix builds emit them into runtime/; an installed project carries them
 * in the brustjs-<platform> optionalDependency package. We gather from both so
 * a dist Just Works in either layout. */
async function collectNativeBinaries(): Promise<string[]> {
  const out: string[] = []
  const isNode = (f: string) => /^brust\..+\.node$/.test(f)

  // (a) runtime/ — local napi build output (single- or multi-platform CI).
  const runtimeDir = path.join(REPO_ROOT, 'runtime')
  try {
    for (const f of await readdir(runtimeDir)) if (isNode(f)) out.push(path.join(runtimeDir, f))
  } catch {}

  // (b) installed platform package — resolved from the brustjs install root so
  // it survives node_modules hoisting.
  try {
    const req = createRequire(path.join(REPO_ROOT, '__brust_resolve__.js'))
    const pkgDir = path.dirname(req.resolve(`${platformPackageName()}/package.json`))
    for (const f of await readdir(pkgDir)) if (isNode(f)) out.push(path.join(pkgDir, f))
  } catch {}

  return out
}

/** The 6 published platform targets (root package.json optionalDependencies),
 * keyed by the napi binary infix `<platform>-<arch>[-<libc>]`. */
export const VALID_TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
] as const

/** Host target infix — reuses the same detection as platformPackageName by
 * stripping the `brustjs-` prefix. */
export function hostTargetInfix(): string {
  return platformPackageName().replace(/^brustjs-/, '')
}

function basenameTarget(absPath: string): string | null {
  const b = absPath.replace(/^.*[/\\]/, '') // basename
  const m = /^brust\.(.+)\.node$/.exec(b)
  return m ? m[1] : null
}

/** Select which collected `brust.*.node` paths to copy for `target`.
 * Pure: takes the collected absolute paths, returns selected paths + errors. */
export function selectNativeBinaries(
  collected: string[],
  target: string,
): { selected: string[]; errors: string[] } {
  // Dedupe tokens here so `selected` never contains duplicate paths — the
  // function's contract is a clean selection, independent of any caller-side
  // copy-dedup (`--target darwin-arm64,darwin-arm64` must select once).
  const tokens = [
    ...new Set(
      target
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const byTarget = new Map<string, string>() // infix → first abs path (dedupe)
  for (const p of collected) {
    const t = basenameTarget(p)
    if (t && !byTarget.has(t)) byTarget.set(t, p)
  }

  if (tokens.length === 0) return { selected: [], errors: ['brust build: empty --target'] }

  const hasAuto = tokens.includes('auto')
  const hasAll = tokens.includes('all')
  if ((hasAuto || hasAll) && tokens.length > 1) {
    return {
      selected: [],
      errors: [
        `brust build: --target "${target}" — auto/all cannot be combined with other targets`,
      ],
    }
  }
  if (hasAll) return { selected: [...byTarget.values()], errors: [] }

  const wanted = hasAuto ? [hostTargetInfix()] : tokens
  const selected: string[] = []
  const errors: string[] = []
  for (const t of wanted) {
    if (!hasAuto && !VALID_TARGETS.includes(t as (typeof VALID_TARGETS)[number])) {
      errors.push(
        `brust build: unknown target "${t}" (valid: ${VALID_TARGETS.join(', ')}, or auto/all)`,
      )
      continue
    }
    const p = byTarget.get(t)
    if (!p) {
      errors.push(
        `brust build: no native binary for target "${t}" — install brustjs-${t} or build it (bun --filter runtime run build)`,
      )
      continue
    }
    selected.push(p)
  }
  return { selected, errors }
}

export interface ParsedArgs {
  entry: string // absolute path to the entry file
  outDir: string // absolute path to the output dir
  target: string // --target value (default 'auto')
  ssg: boolean // --ssg — prerender static routes after the build
  ssgOut: string | null // --ssg-out value (absolute); null → <outDir>/static computed later
  generatorVersion: boolean // false ⇔ --no-generator-version (name-only generator tag)
}

/** Parse `brust build` argv. Pure (no fs access, no process.exit) so it's
 * unit-testable — throws Error on bad input; runBuild owns stderr + exit. */
export function parseArgs(args: string[]): ParsedArgs {
  let entry: string | undefined
  let outDir: string | undefined
  let target = 'auto'
  let ssg = false
  let ssgOut: string | undefined
  let generatorVersion = true

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out-dir') {
      outDir = args[++i]
      if (!outDir) {
        throw new Error('brust build: --out-dir requires a value')
      }
    } else if (a.startsWith('--out-dir=')) {
      outDir = a.slice('--out-dir='.length)
    } else if (a === '--target') {
      target = args[++i]
      if (!target) {
        throw new Error('brust build: --target requires a value')
      }
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length)
      if (!target) {
        throw new Error('brust build: --target= requires a value')
      }
    } else if (a === '--ssg') {
      ssg = true
    } else if (a === '--no-generator-version') {
      generatorVersion = false
    } else if (a === '--ssg-out') {
      ssgOut = args[++i]
      if (!ssgOut) {
        throw new Error('brust build: --ssg-out requires a value')
      }
    } else if (a.startsWith('--ssg-out=')) {
      ssgOut = a.slice('--ssg-out='.length)
      if (!ssgOut) {
        throw new Error('brust build: --ssg-out= requires a value')
      }
    } else if (a.startsWith('-')) {
      throw new Error(`brust build: unknown flag "${a}"`)
    } else if (entry === undefined) {
      entry = a
    } else {
      throw new Error(`brust build: unexpected positional argument "${a}"`)
    }
  }

  const cwd = process.cwd()
  const entryPath = entry
    ? isAbsolute(entry)
      ? entry
      : resolve(cwd, entry)
    : resolve(cwd, 'index.ts')

  const outPath = outDir
    ? isAbsolute(outDir)
      ? outDir
      : resolve(cwd, outDir)
    : resolve(cwd, 'dist')

  if (ssgOut !== undefined && !ssg) {
    throw new Error('brust build: --ssg-out requires --ssg')
  }
  const ssgOutPath = ssgOut ? (isAbsolute(ssgOut) ? ssgOut : resolve(cwd, ssgOut)) : null

  return { entry: entryPath, outDir: outPath, target, ssg, ssgOut: ssgOutPath, generatorVersion }
}

export async function runBuild(args: string[]): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(args)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const { entry, outDir, target } = parsed

  // Entry existence is a runBuild concern (parseArgs stays fs-free/pure).
  if (!existsSync(entry)) {
    console.error(`brust build: no entry file at ${entry}; pass a path or create ./index.ts`)
    process.exit(1)
  }
  const entryDir = path.dirname(entry)

  console.log(`[brust build] entry:  ${entry}`)
  console.log(`[brust build] outDir: ${outDir}`)

  // 1. Clobber outDir.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 2. Actions need no build-time codegen. With `defineActions(...)`, actions
  // are an EXPLICIT module the app entry imports and passes to
  // `brust.run({ actions })` — the dist boot registers them through the normal
  // `import { actions } from './actions'` path, no scan and no `_actions-prebuilt`
  // file. (The old `'use server'` filesystem scanner is gone.)

  // routes.tsx is the scan target for both islands (S3) and the MCP manifest
  // (S4). Computed once here and reused below.
  const routesFile = path.join(entryDir, 'routes.tsx')

  // 2.7. Component CSS — Lightning CSS + CSS Modules. MUST run BEFORE the island
  // and directive bundles: those Bun.build passes bundle components that may
  // `import styles from './X.module.css'`, and the cssLoaderPlugin registered
  // here (from the freshly built manifest) resolves that import to the scoped
  // name map. Without the plugin Bun treats the .module.css as an asset and
  // collides on the output filename (e.g. X.module.css + X.tsx → both X.js).
  // Mirrors brust.run's ordering (plugin registered before buildIslands).
  // Captured here and passed explicitly to buildIslands below (global
  // Bun.plugin() does NOT reach Bun.build).
  const cssBuildPlugins: BunPlugin[] = []
  {
    const { scanCssImports } = await import('../css/scan-imports.ts')
    const scan = await scanCssImports(entryDir)
    if (scan.size > 0) {
      const { buildComponentCss } = await import('../css/component-build.ts')
      const { cssLoaderPlugin } = await import('../css/component-loader.ts')
      let routeForCss: { fullPath: string; componentSources: string[] }[] = []
      if (existsSync(routesFile)) {
        try {
          const { scanImports } = await import('./native-routes-emit.ts')
          const { routes } = await import(routesFile)
          // component name → source file (default imports in routes.tsx).
          const idents = scanImports(routesFile)
          routeForCss = (routes as any[]).map((r) => ({
            fullPath: r.fullPath,
            // Resolve each component in the route's chain (layout → leaf) to its
            // source; computeRouteChunks BFS-walks each subtree for CSS deps.
            componentSources: ((r.chain ?? []) as { Component?: { name?: string } }[])
              .map((node) => node?.Component?.name)
              .map((name) => (name ? idents.get(name) : undefined))
              .filter((p): p is string => typeof p === 'string'),
          }))
        } catch {
          /* if routes import fails, skip — manifest still emits modules */
        }
      }
      const cssOutDir = path.join(outDir, 'css')
      const manifest = await buildComponentCss({
        scanRoot: entryDir,
        outDir: cssOutDir,
        tailwindCompile: null,
        routes: routeForCss,
      })
      const plugin = cssLoaderPlugin(manifest)
      Bun.plugin(plugin) // runtime/SSR resolution of .module.css in the worker isolate
      cssBuildPlugins.push(plugin) // explicit Bun.build resolution for island bundling
      console.log(
        `[brust build] css-mod: ${Object.keys(manifest.modules).length} chunk(s) → ${cssOutDir}/components/`,
      )
    } else {
      console.log(`[brust build] css-mod: skipped (no component CSS imports)`)
    }
  }

  // 2.8. Routes module — loaded ONCE here, AFTER the css block (the import may
  // transitively reach `.module.css`, which needs the cssLoaderPlugin already
  // registered) and BEFORE the island build (the md emit + island scan below
  // need the flat route table). The MCP and ssg steps reuse it.
  let loadedRoutes: any[] | undefined
  if (existsSync(routesFile)) {
    const { routes } = await import(routesFile)
    loadedRoutes = routes
  }

  // 2.9. md routes — emit `Md_*.jinja` into <outDir>/jinja BEFORE the island
  // build so islands used only from md content join the chunk scan, and write
  // the frozen `md-manifest.json` next to BOTH jinja dirs (dist root for the
  // prebuilt boot's loadPrebuiltMdManifest, cwd/.brust for the source runtime —
  // the same dual-emit the jinja mirror below does). Strict no-op without md
  // routes: no files, no dirs, byte-identical dist.
  const jinjaDir = path.join(outDir, 'jinja')

  // Generator tag decision — baked at build time into BOTH jinja dirs so every
  // runtime path (prebuilt dist reads <distDir>/jinja; dev/source reads
  // .brust/jinja) picks up the same artifact. Runs unconditionally: even a
  // React-only app with zero native/md routes needs the artifact so the React
  // stream injector and X-Powered-By thread share the same decision.
  // The .brust/jinja write is defense-in-depth: the 4.1 mirror cp below
  // overwrites it with identical content, but this write must NOT be removed —
  // it keeps the artifact correct even if that cp ever becomes conditional.
  {
    const { generatorStrings, writeGeneratorArtifact } = await import('../generator.ts')
    const gen = generatorStrings(parsed.generatorVersion)
    writeGeneratorArtifact(jinjaDir, gen)
    writeGeneratorArtifact(path.join(process.cwd(), '.brust', 'jinja'), gen)
  }

  let mdIslands = new Map<string, string>()
  if (existsSync(routesFile) && loadedRoutes !== undefined) {
    const { emitMdArtifacts } = await import('../md/emit.ts')
    ;({ mdIslands } = await emitMdArtifacts({
      entryFile: routesFile,
      flatRoutes: loadedRoutes,
      outDir: jinjaDir,
      withDevClient: false,
      manifestDirs: [outDir, path.join(process.cwd(), '.brust')],
      // Build is fatal on a deleted md file — a silent skip would ship a dist
      // with the route registered but its template missing (dev paths default
      // to 'skip-warn' so the hot-reload loop survives the same state).
      onMissing: 'throw',
    }))
    const mdCount = loadedRoutes.filter((r: any) => r?.chain?.at(-1)?.__mdSource).length
    if (mdCount > 0) console.log(`[brust build] md:      ${mdCount} page(s) → ${jinjaDir}`)
  }

  // 3. Build islands (if any <Island> usage is found in the routes graph,
  // plus the md-content islands collected above).
  const { scanIslandChunks, buildIslands } = await import('../islands/build.ts')
  const islandMap = existsSync(routesFile)
    ? scanIslandChunks(routesFile, mdIslands)
    : new Map<string, string>()
  // `fallback: 'client'` SSG routes need the islands RUNTIME (_bootstrap.js
  // drives the client takeover; _react*.js back the fallback chunk's
  // externals) even when the app ships ZERO islands — buildIslands with an
  // empty map emits exactly those runtime files. Without this, the fallback
  // shell references a /_brust/islands/_bootstrap.js that was never built.
  const needsFallbackRuntime =
    parsed.ssg &&
    ((loadedRoutes ?? []) as { chain?: Array<{ ssg?: { fallback?: string } }> }[]).some(
      (r) => r.chain?.at(-1)?.ssg?.fallback === 'client',
    )
  if (islandMap.size > 0 || needsFallbackRuntime) {
    const islandsOutDir = path.join(outDir, 'islands')
    const result = await buildIslands(islandMap, {
      outDir: islandsOutDir,
      plugins: cssBuildPlugins,
    })
    console.log(`[brust build] islands: ${result.islandCount} chunk(s) → ${islandsOutDir}`)

    // Mirror into cwd/.brust/islands so the NON-prebuilt source runtime
    // (`bun run <entry>` directly, and `bun run dev`) — which reads
    // cwd/.brust/islands (see runtime/islands/build.ts default outDir) — finds
    // the same chunks after a build. The prebuilt dist reads <distDir>/islands;
    // this keeps the dev/source path working without a separate bundle step.
    // Mirrors the jinja mirror below. `.brust/` is a gitignored cache dir.
    const localIslandsDir = path.join(process.cwd(), '.brust', 'islands')
    if (path.resolve(localIslandsDir) !== path.resolve(islandsOutDir)) {
      await rm(localIslandsDir, { recursive: true, force: true })
      await cp(islandsOutDir, localIslandsDir, { recursive: true })
    }
  } else {
    console.log('[brust build] islands: skipped (no <Island> usage)')
  }

  // 3.5. Build the directive runtime bundle (if any native interactive component —
  // a file with `export const behavior` — is reachable from the routes graph).
  // MUST run AFTER buildIslands: buildIslands does `rm -rf outDir/islands`, so
  // running this first would wipe _directives.js. This block creates the islands
  // dir itself (the islands block is skipped when there are no <Island> usages).
  {
    const { scanDirectiveComponents, buildDirectives } = await import('../native/build.ts')
    let directiveComponents = new Map<string, string>()
    if (existsSync(routesFile)) {
      try {
        directiveComponents = scanDirectiveComponents(routesFile)
      } catch (err) {
        // e.g. two files derive the same directive register name — surface a clean
        // message instead of an unformatted stack out of `brust build`.
        console.error(`[brust build] directives: ${(err as Error).message}`)
        process.exit(1)
      }
    }
    if (directiveComponents.size > 0) {
      const islandsOutDir = path.join(outDir, 'islands')
      const result = await buildDirectives(directiveComponents, { outDir: islandsOutDir })
      console.log(
        `[brust build] directives: runtime + ${result.count} component chunk(s) → ${islandsOutDir}`,
      )

      // Mirror every directive file (_directives.js + each <name>.directive.js) into
      // cwd/.brust/islands for the source runtime (the islands block's whole-dir mirror
      // ran before these existed, so copy them explicitly). Create the dir in case the
      // islands block was skipped.
      const localIslandsDir = path.join(process.cwd(), '.brust', 'islands')
      if (path.resolve(localIslandsDir) !== path.resolve(islandsOutDir)) {
        await mkdir(localIslandsDir, { recursive: true })
        for (const f of result.files) {
          await cp(path.join(islandsOutDir, f), path.join(localIslandsDir, f))
        }
      }
    } else {
      console.log('[brust build] directives: skipped (no export-const-behavior components)')
    }
  }

  // 4. MCP manifest (if routes.tsx exists). Reuses the routes module loaded in
  // section 2.8.
  if (existsSync(routesFile)) {
    const { extractMcpManifest } = await import('../mcp/extractor.ts')
    const routes = loadedRoutes ?? []
    const actionsFile = path.join(entryDir, 'actions.ts')
    const manifest = await extractMcpManifest({
      actionsFile: existsSync(actionsFile) ? actionsFile : undefined,
      routesFile,
      sourceRoots: [entryDir],
      routes,
    })
    const manifestPath = path.join(outDir, 'mcp-manifest.json')
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
    console.log(
      `[brust build] mcp:     ${manifest.tools.length} tools + ${manifest.resources.length} resources → ${manifestPath}`,
    )
  } else {
    console.log(`[brust build] mcp:     skipped (no routes.tsx)`)
  }

  // 4.1. Sub-project J — emit .brust/jinja/<Name>.jinja templates for every
  // native: true route. Pipeline runs even if no native routes exist (writes
  // an empty manifest) so consumers can rely on the output dir's presence.
  {
    // Emit jinja templates INTO the build output dir (`<outDir>/jinja`), next to
    // the other pre-built artifacts (islands, css, mcp-manifest), so a dist-only
    // deploy ships the templates. The prebuilt runtime reads them from
    // `<BRUST_DIST_DIR>/jinja` (see index.ts loadJinjaOnce / configureJinjaDir).
    // `jinjaDir` is computed in section 2.9, which already emitted the md
    // templates into it; emitNativeTemplates never clears the dir, and the
    // `.brust/jinja` mirror below copies the md templates along.
    // Spec S7 Component-source resolution: scan the routes module's source for
    // ImportDeclarations, NOT the app entry's. The app entry only imports the
    // routes module + brust; the page components are imported by routes.tsx.
    // If routes.tsx doesn't exist (no routes module), we still write an empty
    // manifest below — scanner falls back to passing a dummy path that produces
    // an empty importMap (no native routes to emit anyway).
    await emitNativeTemplates({
      entryFile: existsSync(routesFile) ? routesFile : entry,
      flatRoutes: (loadedRoutes ?? []) as {
        nativeTemplate?: string
        chain?: Array<{ Component?: { name?: string } }>
      }[],
      outDir: jinjaDir,
      repoRoot: REPO_ROOT,
    })
    const nativeCount = (loadedRoutes ?? []).filter((r: any) => r?.nativeTemplate).length
    console.log(`[brust build] jinja:   ${nativeCount} template(s) → ${jinjaDir}`)

    // Also mirror into cwd/.brust/jinja so the NON-prebuilt source runtime
    // (`bun run <entry>` directly, and `bun run dev`) — which reads
    // cwd/.brust/jinja — finds the same templates after a build. The prebuilt
    // dist reads <distDir>/jinja (above); this keeps the dev/source path working
    // without a separate compile step. `.brust/` is a gitignored cache dir.
    const localJinjaDir = path.join(process.cwd(), '.brust', 'jinja')
    if (path.resolve(localJinjaDir) !== path.resolve(jinjaDir)) {
      await rm(localJinjaDir, { recursive: true, force: true })
      await cp(jinjaDir, localJinjaDir, { recursive: true })
    }
  }

  // 4.5. CSS — Tailwind v4 if app.css is present.
  const appCssPath = path.join(entryDir, 'app.css')
  if (existsSync(appCssPath)) {
    const { buildCss } = await import('../css/build.ts')
    const cssOutDir = path.join(outDir, 'css')
    await buildCss({ entry: appCssPath, outDir: cssOutDir })
    console.log(`[brust build] css:     ${cssOutDir}/app.css`)
  } else {
    console.log(`[brust build] css:     skipped (no app.css)`)
  }

  // (Component CSS — Lightning CSS + CSS Modules — moved up to section 2.7 so the
  // cssLoaderPlugin is registered before the island/directive bundles.)

  // Static public assets: copy <project>/public → <dist>/public so a deployed
  // dist is self-contained. No .brust mirror — the source/dev runtime reads
  // <scanRoot>/public directly.
  const publicSrc = path.join(entryDir, 'public')
  if (existsSync(publicSrc)) {
    const publicOut = path.join(outDir, 'public')
    await cp(publicSrc, publicOut, { recursive: true })
    console.log(`[brust build] public:  ${publicSrc} → ${publicOut}`)
  } else {
    console.log('[brust build] public:  skipped (no public/ dir)')
  }

  // 5. Bun.build the server bundle with the native shim plugin + banner. No
  // actions codegen: `defineActions(...)` actions register via the app entry's
  // `import { actions } from './actions'` → `brust.run({ actions })` path, which
  // the bundled entry already carries.
  const banner =
    `process.env.BRUST_PREBUILT = '1';\n` + `process.env.BRUST_DIST_DIR = import.meta.dir;\n`

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    naming: 'index.js',
    target: 'bun',
    format: 'esm',
    // React MUST stay external. Island components on `native: true` routes are
    // SSR'd by importing their SOURCE file at runtime (islands/native-render.ts
    // does `import(sourcePath)`), which resolves `react` from the project's
    // node_modules. If we also bundled a copy of react/react-dom into this
    // server bundle, renderToString (bundled react-dom) would render a source
    // island (node_modules react) across two React instances — "more than one
    // copy of React", a null hook dispatcher, the island SSR failing, and a
    // client hydration mismatch (React #418). Externalizing pins every server-
    // side render to the single node_modules copy the source islands use. (The
    // browser island chunks are a separate build that DOES bundle react.)
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    // Preserve function/class identifiers. The Island component's chunk-id
    // marker on the React path IS `Component.name`, so mangled names would
    // point at non-existent files. Whitespace + syntax minification still apply.
    minify: { whitespace: true, syntax: true, identifiers: false },
    banner,
    // cssBuildPlugins resolves any `.module.css` reached from the entry graph
    // (e.g. routes.tsx → a component's CSS module) to the scoped name map, so
    // Bun doesn't emit the CSS as an asset and collide on the bundle name.
    plugins: [nativeShimPlugin(REPO_ROOT), ...cssBuildPlugins],
  })

  if (!result.success) {
    console.error('brust build: Bun.build failed')
    for (const m of result.logs) console.error(String(m))
    process.exit(1)
  }
  console.log(`[brust build] bundle:  ${path.join(outDir, 'index.js')}`)

  // 7. Copy the selected-platform native binary(ies).
  const nativeDir = path.join(outDir, 'native')
  await mkdir(nativeDir, { recursive: true })

  // napi-rs names the binary `brust.<platform>-<arch>[-libc].node` (binaryName
  // "brust", from the root napi config). Source/CI builds leave it in runtime/;
  // an installed project carries it in the brustjs-<platform> package. The
  // --target flag (default "auto" = host platform) selects which to copy.
  const nativeBinaries = await collectNativeBinaries()
  const { selected, errors } = selectNativeBinaries(nativeBinaries, target)
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  if (selected.length === 0) {
    console.error(
      `brust build: no native binary found for target "${target}". Looked in ` +
        `${path.join(REPO_ROOT, 'runtime')} and the ${platformPackageName()} package. ` +
        `From source run \`bun --filter runtime run build\` first.`,
    )
    process.exit(1)
  }
  const seen = new Set<string>()
  for (const src of selected) {
    const name = path.basename(src)
    if (seen.has(name)) continue
    seen.add(name)
    await copyFile(src, path.join(nativeDir, name))
    console.log(`[brust build] native:  ${name}`)
  }

  // 7.5. SSG fallback chunks (--ssg only): for every route whose LEAF declares
  // `ssg.fallback: 'client'`, bundle a browser chunk that re-exports the leaf
  // component + its `clientLoader` (generated entry → islands buildOne, react
  // externals, content-addressed `Fallback_<Name>_<hash>.js`). Constraint
  // (documented in the spec): the leaf Component must be a DEFAULT import in
  // routes.tsx (scanImports resolution), and its file must export clientLoader.
  // Step 8 hands these to exportStatic (shell/payload crawl + manifest + 404).
  const ssgFallbacks: Array<{ pattern: string; chunk: string }> = []
  if (parsed.ssg) {
    const fallbackRoutes = (
      (loadedRoutes ?? []) as {
        fullPath: string
        chain?: Array<{ ssg?: { fallback?: string }; Component?: { name?: string } }>
      }[]
    ).filter((r) => r.chain?.at(-1)?.ssg?.fallback === 'client')
    if (fallbackRoutes.length > 0) {
      const { fallbackEntrySource, hasClientLoaderExport } = await import('./ssg.ts')
      const { scanImports } = await import('./native-routes-emit.ts')
      const { buildOne } = await import('../islands/build.ts')
      const { islandChunkBasename } = await import('../islands/chunk-id.ts')
      const importMap = scanImports(routesFile)
      const islandsOutDir = path.join(outDir, 'islands')
      await mkdir(islandsOutDir, { recursive: true })
      // Temp dir for the generated entry modules; removed after the bundles land.
      // Error paths THROW (not process.exit) so the finally's cleanup runs —
      // exit(1) inside the try would skip it and leak the temp dir; the catch
      // below owns stderr + exit.
      const entryTmp = await mkdtemp(path.join(tmpdir(), 'brust-fallback-'))
      try {
        for (const [i, route] of fallbackRoutes.entries()) {
          const name = route.chain?.at(-1)?.Component?.name
          const source = name ? importMap.get(name) : undefined
          if (!name || !source) {
            throw new Error(
              `[brust build] ssg: fallback 'client' on "${route.fullPath}": leaf Component must be a DEFAULT import in the routes file`,
            )
          }
          const text = await readFile(source, 'utf8')
          if (!hasClientLoaderExport(text)) {
            throw new Error(
              `[brust build] ssg: fallback 'client' on "${route.fullPath}": ` +
                `${path.relative(process.cwd(), source)} must \`export const clientLoader\``,
            )
          }
          const file = `Fallback_${islandChunkBasename(name, source)}.js`
          // Index-suffixed entry name: two fallback routes may share a component
          // NAME (different files) — the chunk name is already content-addressed.
          const entryPath = path.join(entryTmp, `${name}_${i}.entry.ts`)
          await writeFile(entryPath, fallbackEntrySource(source))
          try {
            await buildOne(
              [entryPath],
              islandsOutDir,
              file,
              ['react', 'react/jsx-runtime', 'react-dom/client'],
              cssBuildPlugins,
            )
          } catch (err) {
            // Browser-safety convention: server-only deps at the component file's
            // top level surface here as bundle errors.
            throw new Error(
              `[brust build] ssg: fallback chunk for "${route.fullPath}": ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          ssgFallbacks.push({ pattern: route.fullPath, chunk: `/_brust/islands/${file}` })
        }
      } catch (err) {
        await rm(entryTmp, { recursive: true, force: true })
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
      await rm(entryTmp, { recursive: true, force: true })
    }
  }

  // 8. SSG export (--ssg): boot the just-built dist once and crawl every
  // statically-renderable route into <--ssg-out | outDir/static>. Reuses the
  // routes module ALREADY loaded for the MCP/css steps (loadedRoutes) — no
  // second import. Without the flag this is a strict no-op.
  if (parsed.ssg) {
    const { collectStaticPaths, expandDynamicRoutes, exportStatic } = await import('./ssg.ts')
    // Initialized to [] so the post-catch read type-checks even where
    // process.exit isn't narrowed to `never` (exit(1) still prevents use).
    let expanded: Awaited<ReturnType<typeof expandDynamicRoutes>> = []
    try {
      expanded = await expandDynamicRoutes(
        (loadedRoutes ?? []) as Parameters<typeof expandDynamicRoutes>[0],
      )
    } catch (err) {
      console.error(`[brust build] ssg: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    const expandedCount = expanded.length - (loadedRoutes ?? []).length
    const decisions = collectStaticPaths(expanded)
    const staticOut = parsed.ssgOut ?? path.join(outDir, 'static')
    try {
      const { written, navWritten, fallbackWritten, skipped } = await exportStatic({
        distDir: outDir,
        entryDir,
        staticOut,
        routes: decisions,
        fallbacks: ssgFallbacks,
      })
      const counts = new Map<string, number>()
      for (const s of skipped) {
        const r = s.reason ?? 'unknown'
        counts.set(r, (counts.get(r) ?? 0) + 1)
      }
      const reasons = [...counts.keys()]
        .sort()
        .map((r) => `${r}=${counts.get(r)}`)
        .join(', ')
      const skippedDesc = skipped.length > 0 ? ` (skipped ${skipped.length}: ${reasons})` : ''
      const expandedDesc = expandedCount > 0 ? `, expanded ${expandedCount} dynamic page(s)` : ''
      const fallbackDesc =
        fallbackWritten.length > 0 ? `, ${fallbackWritten.length} fallback file(s)` : ''
      console.log(
        `[brust build] ssg:     ${written.length} pages + ${navWritten.length} spa payloads${expandedDesc}${fallbackDesc} → ${staticOut}${skippedDesc}`,
      )
      for (const f of ssgFallbacks) {
        console.log(
          `[brust build] ssg:     fallback chunk ${path.basename(f.chunk)} (${f.pattern})`,
        )
      }
    } catch (err) {
      console.error(`[brust build] ssg: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  console.log(`[brust build] done.`)
}
