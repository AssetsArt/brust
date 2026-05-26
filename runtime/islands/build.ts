import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface IslandsBuildResult {
  /** Absolute path to the output directory passed to brust's Rust side. */
  outDir: string
  /** Number of island chunks emitted (excludes runtime + bootstrap). */
  islandCount: number
}

export interface IslandsConfig {
  /** Map of island id → entry file path. Paths are resolved relative
   * to the directory of island.config.ts. */
  islands: Record<string, string>
}

export interface BuildIslandsOptions {
  /** Override the output directory. Default: `<cwd>/.brust/islands`. */
  outDir?: string
}

/** Build the runtime chunks + all island chunks + bootstrap. Returns the
 * absolute output directory; caller passes it to `brust.configureIslandsDir`. */
export async function buildIslands(
  configPath: string,
  options: BuildIslandsOptions = {},
): Promise<IslandsBuildResult> {
  const absConfig = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  const configDir = dirname(absConfig)
  const mod = await import(absConfig)
  const cfg = (mod.default ?? mod) as IslandsConfig
  if (!cfg || typeof cfg !== 'object' || !cfg.islands) {
    throw new Error(`island config at ${absConfig} must export { islands: Record<string, string> }`)
  }

  const outDir = options.outDir
    ? (isAbsolute(options.outDir) ? options.outDir : resolve(process.cwd(), options.outDir))
    : resolve(process.cwd(), '.brust/islands')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // import.meta.dir points to runtime/islands/.
  const entriesDir = resolve(import.meta.dir, '_entries')

  // 1. Combined react + react/jsx-runtime (no externals — bundles React).
  await buildOne([`${entriesDir}/react.ts`], outDir, '_react.js', [])

  // 2. react-dom/client (react external; consumes _react.js via importmap).
  await buildOne([`${entriesDir}/react-dom.ts`], outDir, '_react-dom.js', ['react'])

  // 3. Per-island chunks (all 3 runtime specifiers external).
  const externals = ['react', 'react/jsx-runtime', 'react-dom/client']
  let count = 0
  for (const [id, rel] of Object.entries(cfg.islands)) {
    if (!isValidIslandId(id)) {
      throw new Error(
        `island id ${JSON.stringify(id)} contains invalid characters; ` +
        `allowed: [A-Za-z0-9_-]+ (matches the server's filename safety check)`,
      )
    }
    const entry = isAbsolute(rel) ? rel : resolve(configDir, rel)
    await buildOne([entry], outDir, `${id}.js`, externals)
    count++
  }

  // 4. Bootstrap (react + react-dom/client external; uses importmap).
  const bootstrapSrc = resolve(import.meta.dir, 'bootstrap.ts')
  await buildOne([bootstrapSrc], outDir, '_bootstrap.js', externals)

  return { outDir, islandCount: count }
}

async function buildOne(
  entrypoints: string[],
  outdir: string,
  naming: string,
  external: string[],
): Promise<void> {
  const result = await Bun.build({
    entrypoints,
    outdir,
    naming,
    format: 'esm',
    target: 'browser',
    external,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join('\n')
    throw new Error(`Bun.build failed for ${entrypoints.join(', ')}:\n${messages}`)
  }
}

/** Mirrors `is_safe_island_filename` in src/server.rs — keep in sync.
 * Allows [A-Za-z0-9_-]+ only (no dots in the id; dot is for the extension). */
function isValidIslandId(id: string): boolean {
  if (id.length === 0) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}
