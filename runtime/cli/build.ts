import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path, { isAbsolute, resolve } from 'node:path'
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

interface ParsedArgs {
  entry: string // absolute path to the entry file
  outDir: string // absolute path to the output dir
  target: string // --target value (default 'auto')
}

function parseArgs(args: string[]): ParsedArgs {
  let entry: string | undefined
  let outDir: string | undefined
  let target = 'auto'

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out-dir') {
      outDir = args[++i]
      if (!outDir) {
        console.error('brust build: --out-dir requires a value')
        process.exit(1)
      }
    } else if (a.startsWith('--out-dir=')) {
      outDir = a.slice('--out-dir='.length)
    } else if (a === '--target') {
      target = args[++i]
      if (!target) {
        console.error('brust build: --target requires a value')
        process.exit(1)
      }
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length)
      if (!target) {
        console.error('brust build: --target= requires a value')
        process.exit(1)
      }
    } else if (a.startsWith('-')) {
      console.error(`brust build: unknown flag "${a}"`)
      process.exit(1)
    } else if (entry === undefined) {
      entry = a
    } else {
      console.error(`brust build: unexpected positional argument "${a}"`)
      process.exit(1)
    }
  }

  const cwd = process.cwd()
  const entryPath = entry
    ? isAbsolute(entry)
      ? entry
      : resolve(cwd, entry)
    : resolve(cwd, 'index.ts')

  if (!existsSync(entryPath)) {
    console.error(`brust build: no entry file at ${entryPath}; pass a path or create ./index.ts`)
    process.exit(1)
  }

  const outPath = outDir
    ? isAbsolute(outDir)
      ? outDir
      : resolve(cwd, outDir)
    : resolve(cwd, 'dist')

  return { entry: entryPath, outDir: outPath, target }
}

export async function runBuild(args: string[]): Promise<void> {
  const { entry, outDir, target } = parseArgs(args)
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

  // 3. Build islands (if any <Island> usage is found in the routes graph).
  const { scanIslandChunks, buildIslands } = await import('../islands/build.ts')
  const islandMap = existsSync(routesFile)
    ? scanIslandChunks(routesFile)
    : new Map<string, string>()
  if (islandMap.size > 0) {
    const islandsOutDir = path.join(outDir, 'islands')
    const result = await buildIslands(islandMap, { outDir: islandsOutDir })
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

  // 4. MCP manifest (if routes.tsx exists).
  let loadedRoutes: any[] | undefined
  if (existsSync(routesFile)) {
    const { extractMcpManifest } = await import('../mcp/extractor.ts')
    const { routes } = await import(routesFile)
    loadedRoutes = routes
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
    const jinjaDir = path.join(outDir, 'jinja')
    // Spec S7 Component-source resolution: scan the routes module's source for
    // ImportDeclarations, NOT the app entry's. The app entry only imports the
    // routes module + brust; the page components are imported by routes.tsx.
    // If routes.tsx doesn't exist (no routes module), we still write an empty
    // manifest below — scanner falls back to passing a dummy path that produces
    // an empty importMap (no native routes to emit anyway).
    await emitNativeTemplates({
      entryFile: existsSync(routesFile) ? routesFile : entry,
      flatRoutes: (loadedRoutes ?? []) as { nativeTemplate?: string }[],
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

  // 4.6. Component CSS — Lightning CSS + Modules.
  {
    const { scanCssImports } = await import('../css/scan-imports.ts')
    const scan = await scanCssImports(entryDir)
    if (scan.size > 0) {
      const { buildComponentCss } = await import('../css/component-build.ts')
      const routesFile = path.join(entryDir, 'routes.tsx')
      let routeForCss: { fullPath: string; componentSource: string }[] = []
      if (existsSync(routesFile)) {
        try {
          const { routes } = await import(routesFile)
          routeForCss = (routes as any[]).map((r) => ({
            fullPath: r.fullPath,
            componentSource: routesFile,
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
      console.log(
        `[brust build] css-mod: ${Object.keys(manifest.modules).length} chunk(s) → ${cssOutDir}/components/`,
      )
    } else {
      console.log(`[brust build] css-mod: skipped (no component CSS imports)`)
    }
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
    plugins: [nativeShimPlugin(REPO_ROOT)],
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

  console.log(`[brust build] done.`)
}
