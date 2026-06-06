import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import { scanImports } from '../cli/native-routes-emit.ts'

export interface IslandsBuildResult {
  /** Absolute path to the output directory passed to brust's Rust side. */
  outDir: string
  /** Number of island chunks emitted (excludes runtime + bootstrap). */
  islandCount: number
  /** id → content-addressed chunk URL (`/_brust/islands/<id>_<hash>.js`). Also
   * written to `_islands.js` for the client bootstrap to resolve at runtime. */
  chunks: Record<string, string>
}

export interface BuildIslandsOptions {
  /** Override the output directory. Default: `<cwd>/.brust/islands`. */
  outDir?: string
  /** Build plugins passed straight to `Bun.build` for the per-island chunks.
   * Needed for the component-CSS loader: global `Bun.plugin()` registrations do
   * NOT apply to `Bun.build`, so an island that `import`s a `.module.css` must
   * get the resolver here or Bun emits the CSS as a separate asset and collides
   * on the output filename (X.module.css + X.tsx → both X.js). */
  plugins?: BunPlugin[]
}

/** Scan a routes entry file for `<Island component={X} />` usage and derive the
 * island chunk list (componentName → absolute source path). Replaces the old
 * static config-file lookup — the chunk set is derived from source.
 *
 * 1. Resolve the entry's page imports via {@link scanImports}.
 * 2. For each page, slice every `<Island … />` tag and capture its
 *    `component={Ident}`. A tag with no `component` is a hard error (F3:
 *    never silently skip an island).
 * 3. Resolve each captured ident through that page's OWN imports.
 * 4. Dedup islands that reuse the same component+path; throw on two different
 *    files whose island components share a name (ids must be app-unique).
 */
/** Content-addressed island chunk basename = `<Name>_<8hex(sha256 cwd-relative
 * source path)>`. Stable + app-unique (mirrors the directive chunk scheme) so
 * the URL is content-busting-stable; the bootstrap resolves the plain marker id
 * to this via the `_islands.js` map. */
export function islandChunkBasename(name: string, absSourcePath: string): string {
  const rel = relative(process.cwd(), absSourcePath).replaceAll('\\', '/')
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8)
  return `${name}_${hash}`
}

export function scanIslandChunks(routesEntryFile: string): Map<string, string> {
  const chunks = new Map<string, string>()
  const visited = new Set<string>()

  // BFS over the LOCAL import graph rooted at the routes entry. An <Island> can
  // live in ANY component reachable from the routes — not just a top-level page.
  // (e.g. a shared layout that hosts a floating dock: routes → page → Layout →
  // <Island component={Dock} />.) Stopping at the pages misses those, so the
  // chunk is never built and the browser 404s on `/_brust/islands/<Dock>.js`.
  // `scanImports` only returns LOCAL (relative) default imports, so the walk
  // never escapes into node_modules / `brustjs` / `react`.
  const queue: string[] = [...scanImports(routesEntryFile).values()]
  while (queue.length > 0) {
    const filePath = queue.shift()!
    if (visited.has(filePath)) continue
    visited.add(filePath)

    const source = readFileSync(filePath, 'utf8')
    const fileImports = scanImports(filePath)

    // Follow this file's own local imports transitively.
    for (const dep of fileImports.values()) {
      if (!visited.has(dep)) queue.push(dep)
    }

    // `[^<]*?` (not `[\s\S]*?`) so a tag cannot bridge across another `<` — this
    // stops a bare `<Island>` mentioned in a comment from lazily matching forward
    // to an unrelated later `/>` (which would then falsely report "no component
    // prop"). A real island tag never contains `<` between `<Island` and `/>`.
    const tags = source.match(/<Island\b[^<]*?\/>/g) ?? []
    for (const tag of tags) {
      const compMatch = tag.match(/component=\{\s*(\w+)\s*\}/)
      if (!compMatch) {
        throw new Error(`<Island> tag in ${filePath} has no \`component={...}\` prop: ${tag}`)
      }
      const ident = compMatch[1]!
      const src = fileImports.get(ident)
      if (!src) {
        throw new Error(
          `<Island component={${ident}}> in ${filePath} has no matching import ` +
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

  // 3. Per-island chunks (all 3 runtime specifiers external). Island sources may
  // `import styles from './X.module.css'`, so the component-CSS plugins resolve
  // those imports to the scoped name map (otherwise Bun emits the CSS as an asset).
  const externals = ['react', 'react/jsx-runtime', 'react-dom/client']
  const plugins = options.plugins ?? []
  // id (plain Component name) → content-addressed chunk URL. The chunk filename
  // is `<Name>_<hash>.js`; the data-brust-island marker stays the plain name, so
  // the bootstrap resolves it to the hashed chunk via the `_islands.js` map below.
  const chunks: Record<string, string> = {}
  let count = 0
  for (const [id, entry] of islands) {
    if (!isValidIslandId(id)) {
      throw new Error(
        `island id ${JSON.stringify(id)} contains invalid characters; ` +
          `allowed: [A-Za-z0-9_-]+ (matches the server's filename safety check)`,
      )
    }
    const file = `${islandChunkBasename(id, entry)}.js`
    await buildOne([entry], outDir, file, externals, plugins)
    chunks[id] = `/_brust/islands/${file}`
    count++
  }

  // id → chunk URL map, served at /_brust/islands/_islands.js. The bootstrap
  // loads it once and resolves a marker's plain id to its hashed chunk (with a
  // legacy `/_brust/islands/<id>.js` fallback). ESM default export.
  await writeFile(
    resolve(outDir, '_islands.js'),
    `export default ${JSON.stringify(chunks)}\n`,
    'utf-8',
  )

  // 4. Bootstrap (react + react-dom/client external; uses importmap).
  const bootstrapSrc = resolve(import.meta.dir, 'bootstrap.ts')
  await buildOne([bootstrapSrc], outDir, '_bootstrap.js', externals)

  return { outDir, islandCount: count, chunks }
}

async function buildOne(
  entrypoints: string[],
  outdir: string,
  naming: string,
  external: string[],
  plugins: BunPlugin[] = [],
): Promise<void> {
  const result = await Bun.build({
    entrypoints,
    outdir,
    naming,
    format: 'esm',
    target: 'browser',
    external,
    minify: true,
    plugins,
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
