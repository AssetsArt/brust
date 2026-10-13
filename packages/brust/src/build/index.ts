// `brust build` (spec S5, plan T6): route entry → compiler → `dist/` + `manifest.json`.
// `dist/` is always regenerated from scratch, in a sibling temp dir that replaces it only once the
// whole build succeeded (a failed build leaves the previous dist untouched); nothing in it is
// edited by hand. An out dir that could hold the app's own sources, or a non-empty one that is not
// a previous brust dist (no `manifest.json` / `.brust` marker; `--force` overrides), is refused
// before anything is written or removed.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { BrustRouteError, type FlatRoute, validateRoutes } from '../routes'
import { type BrowserCtx, setDevBuild, buildActions, buildCacheAdapter, buildClientChunks, buildJobs, buildReactChunks, buildRuntime, storeModules } from './bundle'
import { runActionsOnly } from './actions-only'
import { type CfPrepared, buildCloudflare, prepareCloudflare } from './cloudflare'
import { evaluateBuildSlots } from './build-eval'
import { type Compiled, compileApp } from './compile'
import { buildCss, CssGraph, directCss, resolveGlobals, routeCssSources } from './css'
import { type ActionsBuildConfig, type CacheBuildConfig, loadBuildConfig } from './config'
import { BuildError } from './errors'
import { type CacheRecord, type ManifestJson, tierOf, writeManifest } from './manifest'
import { scanRoutes } from './scan'
import { type ExprReads, prepareStatic, writeStatic } from './static'
import { writeStaticWorker } from './static-worker'

export { BuildError } from './errors'

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
    // Only brust's own marker proves a previous build: an unrelated manifest.json (web app,
    // extension) next to user files must not unlock the wipe (review round 3, r3src repro).
    if (names.length === 0 || names.includes(MARKER)) return
  }
  throw new BuildError(
    'out-dir-unsafe',
    `refusing to replace ${dist}: it is not empty and not a previous brust build (no ${MARKER} marker); pass --force to replace it`,
  )
}

function statOk(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export async function runBuild(opts: {
  appRoot: string
  entry: string
  outDir: string
  /** Replace a non-empty out dir even without a previous build's marker. */
  force?: boolean
  /** `cloudflare` also writes `<out>/cf/` (M4-CF); `static` also writes `<out>/static/` (gaps round
   * L9); default `bun` = the unchanged build. */
  target?: 'bun' | 'cloudflare' | 'static'
  /** `--strict` (static): a loader that reads the request fails the build. */
  strict?: boolean
  /** The cache key grammar's read-set (static; tests swap it). Default: the addon. */
  exprReads?: ExprReads
  /** `--wasm-from-source` (cloudflare only). */
  wasmFromSource?: boolean
  /** `--actions-only` (L16 R16.3): no pages, only the `[actions]` app; with `bun` (default) or `cloudflare`. */
  actionsOnly?: boolean
  /** `brust build --dev` (L14, used by `brust dev`): also writes `dev.json` and builds the client runtime with `__BRUST_DEV__`. */
  dev?: boolean
  log: (s: string) => void
}): Promise<void> {
  setDevBuild(opts.dev === true)
  const appRoot = resolve(opts.appRoot)
  const entry = resolve(appRoot, opts.entry)
  const dist = resolve(appRoot, opts.outDir)
  assertSafeOutDir(dist, appRoot, [entry, join(appRoot, 'public')])
  assertReplaceable(dist, opts.force)
  const built = await loadBuildConfig(appRoot, { actionsOnly: opts.actionsOnly === true })
  if (opts.actionsOnly)
    return runActionsOnly({ appRoot, dist, config: built, target: opts.target, wasmFromSource: opts.wasmFromSource === true, statOk, assertSafeOutDir, log: opts.log })
  const { serverOnly, cloudflare, cache, cssGlobal } = built
  // L16 R16.4b: `[actions]` with a `base_url` and no actions file (the default name, not one written in the toml)
  // is a page-only build: the app is deployed elsewhere, so nothing is bundled or mounted here.
  const remote =
    built.actions !== null && built.actions.baseUrl !== undefined && !built.actions.entryExplicit && !statOk(resolve(appRoot, built.actions.entry)) ? built.actions : null
  const actions = remote ? null : built.actions
  if (actions?.prefix === '/') throw new BuildError('config', 'actions.prefix "/" is only for an actions-only build (brust build --actions-only) or a page-only build that points at one')

  // Everything that can fail on the app's own input runs before a byte is written.
  const { routes, componentFile, componentIssue } = await scanRoutes(entry, appRoot)
  let leaves: ReturnType<typeof validateRoutes>
  try {
    leaves = validateRoutes(routes)
  } catch (e) {
    if (e instanceof BrustRouteError) throw new BuildError(e.rule, e.message)
    throw e
  }
  let actionsEntry: string | null = null
  if (actions) {
    actionsEntry = resolve(appRoot, actions.entry)
    const rel = relative(appRoot, actionsEntry)
    if (isAbsolute(actions.entry) || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !statOk(actionsEntry)) {
      throw new BuildError('actions-entry', `actions.entry ${actions.entry} is not a file inside the app`)
    }
    // The actions app answers every path under its prefix, so a page there could never be served.
    for (const l of leaves) {
      if (l.pattern !== '*' && (l.pattern === actions.prefix || l.pattern.startsWith(`${actions.prefix}/`))) {
        throw new BuildError(
          'actions-prefix',
          `route ${l.id} (${l.pattern}) lies under the actions prefix ${actions.prefix}: the actions app answers every path there`,
        )
      }
    }
  }
  let cacheModule: string | null = null
  if (cache?.module !== undefined) {
    cacheModule = resolve(appRoot, cache.module)
    const rel = relative(appRoot, cacheModule)
    if (isAbsolute(cache.module) || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !statOk(cacheModule)) {
      throw new BuildError('cache', `cache.module ${cache.module} is not a file inside the app`)
    }
  }
  assertSafeOutDir(dist, appRoot, [...componentFile.values(), ...(actionsEntry ? [actionsEntry] : []), ...(cacheModule ? [cacheModule] : [])])

  // R9.3/R9.4: every reason to refuse a static build, before any write.
  const ssgPlan =
    opts.target === 'static'
      ? await prepareStatic(leaves, actions !== null, opts.exprReads ?? (await import('../native')).cacheExprReads, opts.log, cache)
      : null

  // Config, @brust/core-cf resolution and the user's wrangler file fail here, before any write.
  // L12: a static build with `[actions]` also builds the Cloudflare worker (its Pages `_worker.js`).
  const hybrid = ssgPlan !== null && actions !== null
  const cf = opts.target === 'cloudflare' || hybrid ? await prepareCloudflare(appRoot, cloudflare, { fromSource: opts.wasmFromSource === true, env: process.env }) : null

  // Sibling of `dist` (same filesystem: the final rename is atomic), fixed name (no random bytes in
  // anything the bundler sees).
  const tmp = join(dirname(dist), `.${basename(dist)}.brust-tmp`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    await buildInto(tmp, { dev: opts.dev === true, appRoot, entry, dist, leaves, componentFile, componentIssue, serverOnly, actions, actionsEntry, cache, cacheModule, cf, hybrid, cssGlobal, actionsRemote: remote?.prefix ?? null, log: opts.log })
    if (ssgPlan) {
      // Rendered from the finished temp dist, so a failed render leaves the previous dist untouched.
      const version: string = (await Bun.file(join(import.meta.dir, '../../package.json')).json()).version
      await writeStatic(tmp, { entry, appRoot, plan: ssgPlan, version, strict: opts.strict === true, log: opts.log, shownDir: join(dist, 'static') })
      if (hybrid && cf && actions) writeStaticWorker(tmp, actions, cf, opts.log)
    }
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
    /** Write `dev.json` (L14). */
    dev: boolean
    appRoot: string
    entry: string
    /** The final dist dir (`index.js` points at the entry relative to it). */
    dist: string
    leaves: ReturnType<typeof validateRoutes>
    componentFile: Map<Function, string>
    componentIssue: Map<Function, string>
    serverOnly: string[]
    actions: ActionsBuildConfig | null
    /** Absolute path of the actions entry (null when `[actions]` is off). */
    actionsEntry: string | null
    cache: CacheBuildConfig | null
    /** Absolute path of a custom cache adapter module. */
    cacheModule: string | null
    cf: CfPrepared | null
    /** `[css] global` as written (app-root relative). */
    cssGlobal: string[]
    /** L16 R16.4b: the prefix of an actions app deployed elsewhere (a page-only build); absent = a local app or none. */
    actionsRemote: string | null
    /** `--target static` with `[actions]`: the worker is built without the cache (static pages are never cached). */
    hybrid: boolean
    log: (s: string) => void
  },
): Promise<void> {
  const { appRoot, entry, leaves } = o
  // L19: every stylesheet first, so each JS build below reads one set of CSS Module class maps.
  const graph = new CssGraph()
  const chainFiles = (l: FlatRoute) => l.chain.flatMap((n) => (n.Component && o.componentFile.has(n.Component) ? [o.componentFile.get(n.Component)!] : []))
  const routeCss = routeCssSources(leaves, chainFiles, resolveGlobals(appRoot, o.cssGlobal), graph)
  const serverCss = [o.actionsEntry, o.cacheModule].flatMap((f) => (f ? graph.of(f) : []))
  mkdirSync(join(out, 'client'), { recursive: true })
  // Review N3: `brust dev` builds with BRUST_BUILD_MODE=development (as the JS bundles): readable, unminified CSS.
  const css = await buildCss(out, [...new Set([...[...routeCss.values()].flat(), ...serverCss])], process.env.BRUST_BUILD_MODE !== 'development', { appRoot, log: o.log })
  for (const c of directCss(entry))
    o.log(`[brust] warning css ${relative(appRoot, entry)} imports ${c}: the route entry belongs to no route, so it is linked nowhere; import it from a layout, or list it in [css] global`)
  const ctx: BrowserCtx = { sourceOf: new Map(), appRoot, serverOnly: o.serverOnly, serverFiles: o.actionsEntry ? [realpathSync(o.actionsEntry)] : [], cssMaps: css.maps }
  // The runtime first: its hashed URL is the `runtimeImport` every client chunk is compiled with.
  const runtime = await buildRuntime(out, ctx)
  const compileOpts = {
    appRoot,
    leaves,
    componentFile: o.componentFile,
    componentIssue: o.componentIssue,
    runtimeImport: `/_brust/${runtime}`,
    serverOnly: o.serverOnly,
  }
  let { compiled, routeComponent } = compileApp({ ...compileOpts, log: o.log })
  // L2: slots that read nothing request- or time-dependent are computed once, here, and the app is
  // compiled again with their values (a slot with a value is a literal: no job, no worker).
  const slotValues = await evaluateBuildSlots(out, compiled, ctx.sourceOf, appRoot, o.log)
  if (Object.keys(slotValues).length > 0) ({ compiled, routeComponent } = compileApp({ ...compileOpts, slotValues, log: () => {} }))

  mkdirSync(join(out, 'jinja'), { recursive: true })
  for (const c of compiled.values()) writeFileSync(join(out, 'jinja', `${c.id}.jinja`), c.jinja)

  const runtimeUrl = `/_brust/${runtime}`
  const chunks = new Map([...(await buildClientChunks(out, compiled, ctx, runtimeUrl)), ...(await buildReactChunks(out, compiled, ctx, runtimeUrl))])
  const manifest = writeManifest({ leaves, routeComponent, compiled, runtime, chunks })
  for (const r of manifest.routes) {
    const files = [...new Set((routeCss.get(r.id) ?? []).flatMap((s) => (css.file.has(s) ? [css.file.get(s)!] : [])))]
    if (files.length > 0) r.css = files
  }
  await buildJobs(out, compiled, ctx.sourceOf, appRoot, storeModules(manifest), css.maps)
  manifest.actions =
    o.actions && o.actionsEntry
      ? { entry: await buildActions(out, o.actionsEntry, css.maps), prefix: o.actions.prefix, maxBodyBytes: o.actions.maxBodyBytes, maxResponseBytes: o.actions.maxResponseBytes, crossSite: o.actions.crossSite }
      : null
  if (o.actionsRemote !== null) manifest.actions_remote = { prefix: o.actionsRemote }
  if (o.cache) manifest.cache = await cacheRecord(out, manifest, o.cache, o.cacheModule, css.maps)
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (o.dev) writeFileSync(join(out, 'dev.json'), `${JSON.stringify(devJson(appRoot, compiled), null, 2)}\n`)
  writeFileSync(join(out, MARKER), 'generated by `brust build`: this directory is replaced on every build\n')

  const pub = join(appRoot, 'public')
  if (existsSync(pub)) cpSync(pub, join(out, 'public'), { recursive: true })
  if (o.cf) {
    const warnings = await buildCloudflare(
      out,
      {
        appRoot,
        entry,
        dist: o.dist,
        compiled,
        manifest: o.hybrid ? { ...manifest, cache: undefined } : manifest,
        sourceOf: ctx.sourceOf,
        actionsEntry: o.actionsEntry,
        cacheModule: o.hybrid ? null : o.cacheModule,
        cacheGetTimeoutMs: o.hybrid ? undefined : o.cache?.getTimeoutMs,
        cssMaps: css.maps,
        log: o.log,
      },
      o.cf,
    )
    for (const w of warnings) o.log(w)
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
      "const { run } = await import('@brust/core')",
      'await run()',
      '',
    ].join('\n'),
  )
}

/** `dev.json` (L14, R14.2): component id → source file, tier, the react reason, diagnostics. Only `brust build --dev` writes it. */
export function devJson(appRoot: string, compiled: Map<string, Compiled>): { version: 1; components: Record<string, DevComponent> } {
  const components: Record<string, DevComponent> = {}
  for (const c of compiled.values()) {
    const tier = tierOf(c.ir)
    const t = c.ir.tier
    components[c.id] = {
      file: relative(appRoot, c.file),
      tier,
      ...(tier === 'react' && t && typeof t === 'object' && 'React' in t ? { reason: String((t as { React: { reason: string } }).React.reason) } : {}),
      diagnostics: (c.diagnostics ?? []).map((d) => ({ class: d.class, rule: d.rule, line: d.line, col: d.col, message: d.message, remediation: d.remediation })),
    }
  }
  return { version: 1, components }
}

export interface DevComponent {
  file: string
  tier: 'static' | 'native' | 'react'
  /** Why the compiler chose the react tier (the IR's `React.reason`). */
  reason?: string
  diagnostics: { class: string; rule: string; line: number; col: number; message: string; remediation: string }[]
}

/** `manifest.cache` (R7, R8): the custom module bundled for the worker, the native defaults, and the
 * build id every L2 key carries. */
async function cacheRecord(out: string, manifest: ManifestJson, c: CacheBuildConfig, moduleAbs: string | null, cssMaps: Map<string, Record<string, string>>): Promise<CacheRecord> {
  const module = moduleAbs ? await buildCacheAdapter(out, moduleAbs, cssMaps) : undefined
  return {
    adapter: c.adapter,
    ...(module ? { module } : {}),
    ...(c.broadcast ? { broadcast: c.broadcast, broadcastOptions: c.broadcastOptions ?? {} } : {}),
    options: c.options,
    namespace: c.namespace,
    getTimeoutMs: c.getTimeoutMs ?? 50,
    maxBodyBytes: c.maxBodyBytes,
    epochIntervalMs: c.epochIntervalMs,
    buildId: computeBuildId(out, manifest),
  }
}

/** R7: the first 16 hex chars of sha256 over the manifest (without `cache`), every `jinja/*.jinja`
 * (by name), `jobs.js` and `actions.js` when present: a rebuild of the same app keeps it, any change
 * to what renders a page moves it (a deploy never serves an older build's L2 bodies). */
export function computeBuildId(out: string, manifest: ManifestJson): string {
  const h = new Bun.CryptoHasher('sha256')
  const { cache: _, ...rest } = manifest
  h.update(JSON.stringify(rest))
  const jinja = join(out, 'jinja')
  for (const f of (existsSync(jinja) ? readdirSync(jinja) : []).filter((f) => f.endsWith('.jinja')).sort()) {
    h.update(`\0${f}\0`)
    h.update(readFileSync(join(jinja, f)))
  }
  for (const f of ['jobs.js', 'actions.js']) {
    const p = join(out, f)
    if (existsSync(p)) {
      h.update(`\0${f}\0`)
      h.update(readFileSync(p))
    }
  }
  return h.digest('hex').slice(0, 16)
}
