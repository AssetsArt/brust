// `brust build` (spec S5, plan T6): route entry → compiler → `dist/` + `manifest.json`.
// `dist/` is always regenerated from scratch, in a sibling temp dir that replaces it only once the
// whole build succeeded (a failed build leaves the previous dist untouched); nothing in it is
// edited by hand. An out dir that could hold the app's own sources, or a non-empty one that is not
// a previous brust dist (no `manifest.json` / `.brust` marker; `--force` overrides), is refused
// before anything is written or removed.
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { BrustRouteError, validateRoutes } from '../routes'
import { type BrowserCtx, buildClientChunks, buildJobs, buildReactChunks, buildRuntime } from './bundle'
import { compileApp } from './compile'
import { loadBuildConfig } from './config'
import { BuildError } from './errors'
import { writeManifest } from './manifest'
import { scanRoutes } from './scan'

export { BuildError } from './errors'

/** The napi addon(s) next to this package (`native/brust.<plat>.node`, built by `napi build`). */
const NATIVE_DIR = resolve(import.meta.dir, '../../native')

/** `p` with symlinks resolved as far as it exists (`/tmp` → `/private/tmp` on macOS). */
function canonical(p: string): string {
  if (existsSync(p)) return realpathSync(p)
  const parent = dirname(p)
  return parent === p ? p : join(canonical(parent), basename(p))
}

/** `child` is `parent` or lies under it. */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Refuses an out dir the build would destroy something precious by replacing: the filesystem
 * root, the home dir, the app root or any of its ancestors, or a dir holding a source (`keep`:
 * the route entry, every route Component file, `public/`). */
export function assertSafeOutDir(dist: string, appRoot: string, keep: string[]): void {
  const d = canonical(dist)
  let why: string | undefined
  if (d === parse(d).root) why = 'is the filesystem root'
  else if (d === canonical(homedir())) why = 'is the home directory'
  else if (within(canonical(appRoot), d)) why = `contains the app root ${appRoot}`
  else {
    const src = keep.find((k) => within(canonical(k), d))
    if (src !== undefined) why = `contains ${src}`
  }
  if (why) throw new BuildError('out-dir-unsafe', `refusing to replace ${dist}: it ${why} (pick a dedicated directory, e.g. dist)`)
}

/** Marker file written into every dist: a later build may replace a dir that has it. */
const MARKER = '.brust'

/** Refuses to replace an existing, non-empty out dir that is not a previous brust dist (neither
 * `manifest.json` nor the `.brust` marker in it), unless `force`. */
export function assertReplaceable(dist: string, force = false): void {
  if (force || !existsSync(dist)) return
  if (statSync(dist).isDirectory()) {
    const names = readdirSync(dist)
    if (names.length === 0 || names.includes('manifest.json') || names.includes(MARKER)) return
  }
  throw new BuildError(
    'out-dir-unsafe',
    `refusing to replace ${dist}: it is not empty and not a previous brust build (no manifest.json or ${MARKER} marker); pass --force to replace it`,
  )
}

export async function runBuild(opts: {
  appRoot: string
  entry: string
  outDir: string
  /** Replace a non-empty out dir even without a previous build's marker. */
  force?: boolean
  log: (s: string) => void
}): Promise<void> {
  const appRoot = resolve(opts.appRoot)
  const entry = resolve(appRoot, opts.entry)
  const dist = resolve(appRoot, opts.outDir)
  assertSafeOutDir(dist, appRoot, [entry, join(appRoot, 'public')])
  assertReplaceable(dist, opts.force)
  const { serverOnly } = await loadBuildConfig(appRoot)

  // Everything that can fail on the app's own input runs before a byte is written.
  const { routes, componentFile } = await scanRoutes(entry)
  let leaves: ReturnType<typeof validateRoutes>
  try {
    leaves = validateRoutes(routes)
  } catch (e) {
    if (e instanceof BrustRouteError) throw new BuildError(e.rule, e.message)
    throw e
  }
  assertSafeOutDir(dist, appRoot, [...componentFile.values()])

  // Sibling of `dist` (same filesystem: the final rename is atomic), fixed name (no random bytes in
  // anything the bundler sees).
  const tmp = join(dirname(dist), `.${basename(dist)}.brust-tmp`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    await buildInto(tmp, { appRoot, entry, dist, leaves, componentFile, serverOnly, log: opts.log })
    rmSync(join(tmp, '.stage'), { recursive: true, force: true })
    if (existsSync(dist)) {
      const old = join(dirname(dist), `.${basename(dist)}.brust-old`)
      rmSync(old, { recursive: true, force: true })
      renameSync(dist, old)
      renameSync(tmp, dist)
      rmSync(old, { recursive: true, force: true })
    } else renameSync(tmp, dist)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

async function buildInto(
  out: string,
  o: {
    appRoot: string
    entry: string
    /** The final dist dir (`index.js` points at the entry relative to it). */
    dist: string
    leaves: ReturnType<typeof validateRoutes>
    componentFile: Map<Function, string>
    serverOnly: string[]
    log: (s: string) => void
  },
): Promise<void> {
  const { appRoot, entry, leaves } = o
  const ctx: BrowserCtx = { sourceOf: new Map(), appRoot, serverOnly: o.serverOnly }
  // The runtime first: its hashed URL is the `runtimeImport` every client chunk is compiled with.
  const runtime = await buildRuntime(out, ctx)
  const { compiled, routeComponent } = compileApp({
    appRoot,
    leaves,
    componentFile: o.componentFile,
    runtimeImport: `/_brust/${runtime}`,
    serverOnly: o.serverOnly,
    log: o.log,
  })

  mkdirSync(join(out, 'jinja'), { recursive: true })
  for (const c of compiled.values()) writeFileSync(join(out, 'jinja', `${c.id}.jinja`), c.jinja)

  const chunks = new Map([...(await buildClientChunks(out, compiled, ctx)), ...(await buildReactChunks(out, compiled, ctx))])
  await buildJobs(out, compiled, ctx.sourceOf, appRoot)

  const manifest = writeManifest({ leaves, routeComponent, compiled, runtime, chunks })
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(out, MARKER), 'generated by `brust build`: this directory is replaced on every build\n')

  const pub = join(appRoot, 'public')
  if (existsSync(pub)) cpSync(pub, join(out, 'public'), { recursive: true })
  if (existsSync(NATIVE_DIR)) {
    mkdirSync(join(out, 'native'), { recursive: true })
    for (const f of readdirSync(NATIVE_DIR)) if (f.endsWith('.node')) cpSync(join(NATIVE_DIR, f), join(out, 'native', f))
  }
  const entryRel = relative(o.dist, entry)
  writeFileSync(
    join(out, 'index.js'),
    [
      '// generated by `brust build` — `bun dist/index.js` starts the app (do not edit)',
      "import { join } from 'node:path'",
      "process.env.BRUST_PREBUILT = '1'",
      'process.env.BRUST_DIST_DIR = import.meta.dir',
      `process.env.BRUST_APP_ENTRY = join(import.meta.dir, ${JSON.stringify(entryRel)})`,
      "const { run } = await import('@brust/brust')",
      'await run()',
      '',
    ].join('\n'),
  )
}
