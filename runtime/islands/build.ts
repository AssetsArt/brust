import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import { scanImports } from '../cli/native-routes-emit.ts'
import { islandChunkBasename } from './chunk-id.ts'

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
 * 4. Key by the content-addressed {@link islandChunkBasename} (`<Name>_<hash>`),
 *    NOT the bare name — so two DIFFERENT files exporting a same-named component
 *    produce two distinct chunks. Same name + same file dedups (same id). The
 *    marker carries this same id (native: reconcileIslandManifest rewrite;
 *    React: the Component→id registry seeded at worker boot), so there is no
 *    app-unique-name requirement.
 *
 * `extraIslands` (task 2.8) merges additional islands the routes-graph scan
 * cannot see — md-route islands resolved by `emitMdTemplates` (`name →
 * absolute source path`, the bare-name map it returns). Each is keyed by the
 * same content-addressed id, so same name + same path dedups against the scan
 * result; same name + different path yields a distinct id (two chunks, the
 * shipped same-name parity). A same-id-different-path collision is a hard
 * error — never silently rebind a chunk id.
 */
export function scanIslandChunks(
  routesEntryFile: string,
  extraIslands?: Map<string, string>,
): Map<string, string> {
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
      // Key by the content-addressed id: same name + same file → one chunk
      // (dedup); same name + DIFFERENT file → two distinct ids → two chunks.
      // Collisions are impossible (the id embeds a hash of the source path).
      chunks.set(islandChunkBasename(ident, src), src)
    }
  }

  for (const [name, src] of extraIslands ?? []) {
    const id = islandChunkBasename(name, src)
    const existing = chunks.get(id)
    if (existing !== undefined && existing !== src) {
      throw new Error(
        `island chunk id "${id}" resolves to two different sources: ${existing} and ${src}`,
      )
    }
    chunks.set(id, src)
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
  // The map is keyed by the content-addressed id (scanIslandChunks), which IS the
  // chunk basename — the data-brust-island marker carries that same id, so the
  // bootstrap loads the right chunk directly.
  const chunks: Record<string, string> = {}
  const sources: Record<string, string> = {}
  const urlsByName = new Map<string, string[]>()
  let count = 0
  for (const [id, entry] of islands) {
    if (!isValidIslandId(id)) {
      throw new Error(
        `island id ${JSON.stringify(id)} contains invalid characters; ` +
          `allowed: [A-Za-z0-9_-]+ (matches the server's filename safety check)`,
      )
    }
    const file = `${id}.js`
    await buildOne([entry], outDir, file, externals, plugins)
    const url = `/_brust/islands/${file}`
    chunks[id] = url
    // PROJECT-RELATIVE source path (no leaked abs build path); the worker
    // rehydrates it against cwd to build the Component→id registry.
    sources[id] = relative(process.cwd(), entry).replaceAll('\\', '/')
    const name = id.replace(/_[a-f0-9]{8}$/, '')
    const list = urlsByName.get(name)
    if (list) list.push(url)
    else urlsByName.set(name, [url])
    count++
  }
  // Also expose each chunk by its plain Component name when that name is
  // UNAMBIGUOUS (one source) — a defensive fallback for a marker that carries
  // the bare name (e.g. the registry wasn't seeded). Ambiguous names are omitted:
  // those markers carry the unique id (native rewrite / React registry).
  for (const [name, urls] of urlsByName) {
    if (urls.length === 1 && !(name in chunks)) chunks[name] = urls[0]!
  }

  // id → chunk URL map, served at /_brust/islands/_islands.js. The bootstrap
  // loads it once and resolves a marker's id to its chunk (legacy
  // `/_brust/islands/<id>.js` fallback). ESM default export.
  await writeFile(
    resolve(outDir, '_islands.js'),
    `export default ${JSON.stringify(chunks)}\n`,
    'utf-8',
  )

  // id → project-relative source path. The worker imports each at boot and maps
  // the default export (component fn) → id, seeding island.tsx's registry so the
  // React render path emits the content-addressed marker (same-name parity).
  await writeFile(resolve(outDir, '_island-sources.json'), JSON.stringify(sources), 'utf-8')

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
