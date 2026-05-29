import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { scanImports } from '../cli/native-routes-emit.ts'

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

/** Scan a routes entry file for `<Island component={X} />` usage and derive the
 * island chunk list (componentName → absolute source path). Replaces the old
 * `island.config.ts` lookup.
 *
 * 1. Resolve the entry's page imports via {@link scanImports}.
 * 2. For each page, slice every `<Island … />` tag and capture its
 *    `component={Ident}`. A tag with no `component` is a hard error (F3:
 *    never silently skip an island).
 * 3. Resolve each captured ident through that page's OWN imports.
 * 4. Dedup islands that reuse the same component+path; throw on two different
 *    files whose island components share a name (ids must be app-unique).
 */
export function scanIslandChunks(routesEntryFile: string): Map<string, string> {
  const pages = scanImports(routesEntryFile)
  const chunks = new Map<string, string>()

  for (const pagePath of pages.values()) {
    const source = readFileSync(pagePath, 'utf8')
    const pageImports = scanImports(pagePath)

    const tags = source.match(/<Island\b[\s\S]*?\/>/g) ?? []
    for (const tag of tags) {
      const compMatch = tag.match(/component=\{\s*(\w+)\s*\}/)
      if (!compMatch) {
        throw new Error(
          `<Island> tag in ${pagePath} has no \`component={...}\` prop: ${tag}`,
        )
      }
      const ident = compMatch[1]!
      const src = pageImports.get(ident)
      if (!src) {
        throw new Error(
          `<Island component={${ident}}> in ${pagePath} has no matching import ` +
            `(expected \`import ${ident} from "..."\`)`,
        )
      }
      const existing = chunks.get(ident)
      if (existing === undefined) {
        chunks.set(ident, src)
      } else if (existing !== src) {
        throw new Error(
          `island component name "${ident}" is used by two different files ` +
            `(${existing} and ${src}); island component names must be app-unique`,
        )
      }
      // existing === src → same component reused; dedupe (skip).
    }
  }

  return chunks
}

/** Build the runtime chunks + all island chunks + bootstrap. Returns the
 * absolute output directory; caller passes it to `brust.configureIslandsDir`. */
export async function buildIslands(
  islands: Map<string, string>,
  options: BuildIslandsOptions = {},
): Promise<IslandsBuildResult> {
  const outDir = options.outDir
    ? isAbsolute(options.outDir)
      ? options.outDir
      : resolve(process.cwd(), options.outDir)
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
  for (const [id, entry] of islands) {
    if (!isValidIslandId(id)) {
      throw new Error(
        `island id ${JSON.stringify(id)} contains invalid characters; ` +
          `allowed: [A-Za-z0-9_-]+ (matches the server's filename safety check)`,
      )
    }
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
