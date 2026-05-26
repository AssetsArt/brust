import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import path, { isAbsolute, resolve } from 'node:path'
import { actionsPrebuiltPlugin, writePrebuiltActionsFileWithMap } from './actions-prebuilt-plugin.ts'
import { nativeShimPlugin } from './native-shim-plugin.ts'

/** repoRoot = the directory that contains runtime/. This file lives at
 * runtime/cli/build.ts so two dirname() steps get us there. */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

interface ParsedArgs {
  entry: string         // absolute path to the entry file
  outDir: string        // absolute path to the output dir
}

function parseArgs(args: string[]): ParsedArgs {
  let entry: string | undefined
  let outDir: string | undefined

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
    ? (isAbsolute(entry) ? entry : resolve(cwd, entry))
    : resolve(cwd, 'index.ts')

  if (!existsSync(entryPath)) {
    console.error(`brust build: no entry file at ${entryPath}; pass a path or create ./index.ts`)
    process.exit(1)
  }

  const outPath = outDir
    ? (isAbsolute(outDir) ? outDir : resolve(cwd, outDir))
    : resolve(cwd, 'dist')

  return { entry: entryPath, outDir: outPath }
}

export async function runBuild(args: string[]): Promise<void> {
  const { entry, outDir } = parseArgs(args)
  const entryDir = path.dirname(entry)

  console.log(`[brust build] entry:  ${entry}`)
  console.log(`[brust build] outDir: ${outDir}`)

  // 1. Clobber outDir.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 2. Scan actions + rediscover id→source mapping for the prebuilt plugin.
  const { scanActions, collectExports } = await import('../scan-actions.ts')
  const scan = await scanActions({ roots: [entryDir] })
  console.log(`[brust build] actions: discovered ${scan.actions.length} (${scan.actions.map((a) => a.id).join(', ') || '(none)'})`)

  const idToSource = new Map<string, string>()
  for (const file of scan.sourceFiles) {
    const defs = await collectExports(file)
    for (const def of defs) idToSource.set(def.id, file)
  }

  // 3. Build islands (if config exists).
  const islandConfig = path.join(entryDir, 'island.config.ts')
  if (existsSync(islandConfig)) {
    const { buildIslands } = await import('../islands/build.ts')
    const islandsOutDir = path.join(outDir, 'islands')
    const result = await buildIslands(islandConfig, { outDir: islandsOutDir })
    console.log(`[brust build] islands: ${result.islandCount} chunk(s) → ${islandsOutDir}`)
  } else {
    console.log(`[brust build] islands: skipped (no island.config.ts)`)
  }

  // 4. MCP manifest (if routes.tsx exists).
  const routesFile = path.join(entryDir, 'routes.tsx')
  if (existsSync(routesFile)) {
    const { extractMcpManifest } = await import('../mcp/extractor.ts')
    const { routes } = await import(routesFile)
    const manifest = await extractMcpManifest({
      serverFiles: scan.sourceFiles,
      routesFile,
      sourceRoots: [entryDir],
      actions: scan.actions,
      routes,
    })
    const manifestPath = path.join(outDir, 'mcp-manifest.json')
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
    console.log(`[brust build] mcp:     ${manifest.tools.length} tools + ${manifest.resources.length} resources → ${manifestPath}`)
  } else {
    console.log(`[brust build] mcp:     skipped (no routes.tsx)`)
  }

  // 5. Generate the prebuilt-actions file (always — empty list if no actions).
  const prebuiltActionsPath = path.join(outDir, '_actions-prebuilt.ts')
  await writePrebuiltActionsFileWithMap(prebuiltActionsPath, idToSource, REPO_ROOT)

  // 6. Bun.build the server bundle with both plugins + banner.
  const banner =
    `process.env.BRUST_PREBUILT = '1';\n` +
    `process.env.BRUST_DIST_DIR = import.meta.dir;\n`

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    naming: 'index.js',
    target: 'bun',
    format: 'esm',
    minify: true,
    banner,
    plugins: [
      nativeShimPlugin(REPO_ROOT),
      actionsPrebuiltPlugin(prebuiltActionsPath, REPO_ROOT),
    ],
  })

  if (!result.success) {
    console.error('brust build: Bun.build failed')
    for (const m of result.logs) console.error(String(m))
    process.exit(1)
  }
  console.log(`[brust build] bundle:  ${path.join(outDir, 'index.js')}`)

  // 7. Copy the current-platform native binary.
  const nativeDir = path.join(outDir, 'native')
  await mkdir(nativeDir, { recursive: true })

  // napi-rs emits `runtime/index.<platform>-<arch>[-libc].node`. We copy
  // every `index.*.node` we find in runtime/ so a multi-platform pre-build
  // (CI matrix) Just Works without further wiring; in single-platform local
  // builds this is just one file.
  const runtimeDir = path.join(REPO_ROOT, 'runtime')
  const nodeFiles = (await readdir(runtimeDir)).filter(
    (f) => /^index\..+\.node$/.test(f),
  )
  if (nodeFiles.length === 0) {
    console.error(
      `brust build: no native binary found in ${runtimeDir}. ` +
      `Run \`bun --filter runtime run build\` (or :debug) first.`,
    )
    process.exit(1)
  }
  for (const f of nodeFiles) {
    await copyFile(path.join(runtimeDir, f), path.join(nativeDir, f))
    console.log(`[brust build] native:  ${f}`)
  }

  console.log(`[brust build] done.`)
}
