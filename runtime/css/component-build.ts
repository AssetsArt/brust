import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { scanCssImports } from './scan-imports.ts'
import { processCssFile } from './process-modules.ts'
import { computeRouteChunks, type RouteForCss } from './route-deps.ts'
import { writeComponentCssManifest, type ComponentCssManifest } from './manifest.ts'

export interface BuildComponentCssOptions {
  /** Absolute path to the user's app dir (where Home.tsx lives). */
  scanRoot: string
  /** Absolute path under which chunk files + manifest are written. */
  outDir: string
  /** Optional Tailwind compiler (for @apply resolution). */
  tailwindCompile: Parameters<typeof processCssFile>[0]['tailwindCompile']
  /** Routes to map to CSS chunks. */
  routes: RouteForCss[]
}

/** Run the full component CSS pipeline: scan → process → emit chunks +
 * .d.ts + manifest. Returns the in-memory manifest for callers (brust.run)
 * that need to register the Bun.plugin immediately. */
export async function buildComponentCss(
  opts: BuildComponentCssOptions,
): Promise<ComponentCssManifest> {
  const scan = await scanCssImports(opts.scanRoot)

  // Collect unique CSS file paths (a file may be imported from multiple .tsx).
  const cssFiles = new Map<string, { isModule: boolean }>()
  for (const deps of scan.values()) {
    for (const d of deps) cssFiles.set(d.path, { isModule: d.isModule })
  }

  const chunksDir = path.join(opts.outDir, 'components')
  await mkdir(chunksDir, { recursive: true })

  const modules: ComponentCssManifest['modules'] = {}
  for (const [absPath, { isModule }] of cssFiles) {
    const source = await readFile(absPath, 'utf-8')
    const result = await processCssFile({
      filename: absPath,
      source,
      isModule,
      tailwindCompile: opts.tailwindCompile,
    })
    // Deterministic chunk filename: sha256 of relative path. relPath alone
    // is enough for identity; content changes would update file mtime but
    // not the chunk path (stable URL → browser cache reuse).
    const rel = path.relative(opts.scanRoot, absPath)
    const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8)
    const chunkName = `${hash}.css`
    await writeFile(path.join(chunksDir, chunkName), result.code)
    modules[absPath] = {
      chunk: `/_brust/css/components/${chunkName}`,
      exports: result.exports,
    }
    if (isModule) {
      const lines = ['declare const styles: {']
      for (const k of Object.keys(result.exports ?? {})) {
        lines.push(`  readonly ${k}: string`)
      }
      lines.push('}', 'export default styles', '')
      await writeFile(absPath + '.d.ts', lines.join('\n'), 'utf-8')
    }
  }

  // Convert modules map into shape expected by computeRouteChunks.
  const lookup: Record<string, { chunk: string }> = {}
  for (const [p, m] of Object.entries(modules)) lookup[p] = { chunk: m.chunk }
  const routeChunks = computeRouteChunks(opts.routes, scan, lookup)

  const manifest: ComponentCssManifest = { version: 1, modules, routeChunks }
  await writeComponentCssManifest(
    path.join(opts.outDir, 'css', 'component-manifest.json'),
    manifest,
  )
  return manifest
}
