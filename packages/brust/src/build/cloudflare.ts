// `brust build --target cloudflare` (M4-CF spec §4): after the normal build, writes `<out>/cf/`:
//   worker/      the @brust/core-cf glue + wasm (verbatim)  +  <appModuleDir>/brust-app.js (ONE Bun bundle, R2)
//   assets/      Static Assets tree + _headers (R7)         wrangler.jsonc  (user config merged with brust's keys, R5)
//   .stage/      the generated entry + the smoke harness (kept for inspection)
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import type { BunPlugin } from 'bun'
import { BrustConfigError, type CorsConfig, loadCors } from '../config'
import { layoutAssets } from './cf-assets'
import { serverOnlyEmptyPlugin } from './server-only'
import { type CfConfigJson, cfEntrySource } from './cf-entry'
import { type CoreCf, resolveCoreCf } from './cf-core'
import { type CacheNeed, mergeWrangler, readUserWrangler, renderWrangler, type UserWrangler, verifyCacheBindings } from './cf-wrangler'
import { type CloudflareBuildConfig, CF_MIN_COMPAT_DATE } from './config'
import { MANIFEST_VERSION } from './manifest'
import { exposePlugin, PRODUCTION, type SourceOf, sourceDirPlugin } from './bundle'
import type { Compiled } from './compile'
import { cssPlugin } from './css'
import { BuildError } from './errors'
import type { CacheRecord } from './manifest'
import { BUILTINS as CACHE_BUILTINS } from '../cache-adapter/load'

export interface CfFlags {
  fromSource: boolean
  env: Record<string, string | undefined>
}

export interface CfPrepared {
  cfg: CloudflareBuildConfig
  core: CoreCf
  user: UserWrangler
  coreVersion: string
  pkgName: string | undefined
  /** brust.toml `[cors]`, validated before any write */
  cors: CorsConfig | undefined
  warnings: string[]
}

const DEFAULT_CFG: CloudflareBuildConfig = { name: undefined, compatibilityDate: undefined, l1Capacity: 256, jobCacheCapacity: 512, stats: false, edgeCache: 'off', alias: {} }

/** Everything that can fail on the app's own input or install, before a byte is written (index.ts rule). */
export async function prepareCloudflare(appRoot: string, cfg: CloudflareBuildConfig | null, flags: CfFlags): Promise<CfPrepared> {
  const core = resolveCoreCf({ appRoot, fromSource: flags.fromSource, env: flags.env })
  const user = await readUserWrangler(appRoot)
  const warnings = [...core.warnings]
  try {
    const toml = Bun.file(join(appRoot, 'brust.toml'))
    if (await toml.exists()) {
      const root = Bun.TOML.parse(await toml.text()) as Record<string, unknown>
      for (const k of ['server', 'workers']) if (k in root) warnings.push(`[brust] brust.toml [${k}] is ignored on this target`)
    }
  } catch {
    // loadBuildConfig already reported a malformed brust.toml
  }
  let pkgName: string | undefined
  try {
    pkgName = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { name?: string }).name
  } catch {
    pkgName = undefined
  }
  const coreVersion = String((JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0')
  let cors: CorsConfig | undefined
  try {
    cors = await loadCors(appRoot)
  } catch (e) {
    if (e instanceof BrustConfigError) throw new BuildError('config', e.message)
    throw e
  }
  return { cfg: cfg ?? DEFAULT_CFG, core, user, coreVersion, pkgName, cors, warnings }
}

export interface CfBuildCtx {
  appRoot: string
  entry: string
  /** the FINAL dist dir (`out` is a tmp sibling that is renamed to it): wrangler paths are relative to `<dist>/cf` */
  dist: string
  compiled: Map<string, Compiled>
  manifest: { components: Record<string, { template: string }>; actions?: { prefix: string; maxBodyBytes: number; maxResponseBytes?: number; crossSite?: 'reject' | 'allow' } | null; cache?: CacheRecord }
  sourceOf: SourceOf
  actionsEntry: string | null
  /** L16 R16.3: an actions-only Worker: no pages (no routes entry, no jobs, no templates), no Static Assets. */
  actionsOnly?: boolean
  /** A custom cache adapter's source module (absolute). */
  cacheModule?: string | null
  /** `[cache] get_timeout_ms` as written (absent → the Workers default, 100). */
  cacheGetTimeoutMs?: number
  /** L19: CSS Module class maps (the worker reads the same map as the browser). */
  cssMaps?: Map<string, Record<string, string>>
  log: (s: string) => void
}

/** The resolution conditions of the Worker bundle; the package-resolver probe (`sourceDirPlugin`) must carry the same (F223). */
export const CF_CONDITIONS = ['workerd', 'worker', 'browser']

const CORE_SRC = join(import.meta.dir, '..')
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')))

/** Violations of the Workers host surface: `bun`/`bun:*` anywhere in the graph (R2 f). */
function cfGuard(appRoot: string, violations: string[]): BunPlugin {
  return {
    name: 'brust-cf-guard',
    setup(b) {
      b.onResolve({ filter: /^bun(:.*)?$/ }, (a) => {
        violations.push(`${relative(appRoot, a.importer) || a.importer} imports ${a.path}`)
        return { path: a.path, external: true }
      })
      b.onResolve({ filter: /^[a-z_]+(\/[a-z_/]+)?$/ }, (a) => (BUILTINS.has(a.path) ? { path: `node:${a.path}`, external: true } : undefined))
    },
  }
}

/** `[cloudflare] alias` (spec R12): a module whose resolved path is a key is replaced by its value. */
function cfAlias(alias: Record<string, string>, sourceOf: SourceOf): BunPlugin {
  return {
    name: 'brust-cf-alias',
    setup(b) {
      if (Object.keys(alias).length === 0) return
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.importer === '' || a.importer.includes('/node_modules/')) return undefined
        let abs: string
        try {
          abs = Bun.resolveSync(a.path, dirname(sourceOf.get(a.importer) ?? a.importer))
        } catch {
          return undefined
        }
        const to = alias[abs]
        return to === undefined ? undefined : { path: to }
      })
    },
  }
}

/** The CF bundle's stand-in for the napi addon (`native.ts` `require('../native/index.js')`, R8): every call
 * fails loudly, since a Worker has no addon. */
function cfNativeStub(handlersPath: string): BunPlugin {
  const names = ['startServer', 'registerWorker', 'untilReady', 'beginDrain', 'cacheInvalidate', 'cacheStats', 'localAddr', 'planJobs', 'planJobsBuf', 'takeFetchBody', 'putFetchReply', 'cacheReplay', 'cacheL2Count', 'cacheClear']
  return {
    name: 'brust-cf-native',
    setup(b) {
      b.onResolve({ filter: /^\.\.\/native\/index\.js$/ }, (a) => (/[\\/]src[\\/]native\.ts$/.test(a.importer) ? { path: 'brust-cf-native', namespace: 'brust-cf' } : undefined))
      b.onLoad({ filter: /.*/, namespace: 'brust-cf' }, () => ({
        loader: 'js',
        // cacheInvalidate -> the `rt.invalidate` the glue installed at start (ruling 19753649); the rest has no Worker meaning.
        contents: `import { installedRuntime } from ${JSON.stringify(handlersPath)}\nconst no = (n) => () => { throw new Error(n + ' is not available on Cloudflare Workers') }\nmodule.exports = {${names.map((n) => (n === 'cacheInvalidate' ? 'cacheInvalidate: (a) => installedRuntime().invalidate(a)' : `${n}: no(${JSON.stringify(n)})`)).join(', ')}}\n`,
      }))
    },
  }
}

/** The @brust/core `workerStorePlugin` twin for a bundle that inlines `@brust/core` (not external). */
function cfStorePlugin(appRoot: string): BunPlugin {
  return {
    name: 'brust-cf-store',
    setup(b) {
      // The core's own re-export files (`src/store/{index,react}.ts`) must keep their real target, else they loop.
      b.onResolve({ filter: /^@brust\/runtime-dom\/store(\/react)?$/ }, (a) =>
        a.importer.startsWith(CORE_SRC) ? undefined : { path: Bun.resolveSync(a.path.replace('@brust/runtime-dom', '@brust/core'), appRoot) },
      )
    },
  }
}

/** The entry's cache wiring (R8 on Workers): the custom source module or the built-in spec; an `env:`
 * option cannot be resolved inside a Worker (no process env at bundle time) and is refused. */
function cfEntryCache(c: CacheRecord, customModule: string | null) {
  const noEnv = (o: Record<string, unknown> | undefined) => {
    for (const [k, v] of Object.entries(o ?? {}))
      if (typeof v === 'string' && v.startsWith('env:')) throw new BuildError('cache', `cache option ${k}: "env:" values are not available on Cloudflare Workers (use a binding)`)
  }
  noEnv(c.options)
  noEnv(c.broadcastOptions)
  const module = c.adapter === 'custom' ? customModule : CACHE_BUILTINS[c.adapter]
  if (!module) throw new BuildError('cache', `cache adapter "${c.adapter}" has no module to bundle`)
  return { module, options: c.options, ...(c.broadcast ? { broadcast: CACHE_BUILTINS[c.broadcast]!, broadcastOptions: c.broadcastOptions ?? {} } : {}) }
}

/** R2/R10: which Cloudflare bindings the configured cache needs (`[cache.cloudflare]` keys land in the adapter's options), or null. */
export function cacheNeeds(c: Pick<CacheRecord, 'adapter' | 'broadcast' | 'options' | 'broadcastOptions'> | undefined): CacheNeed | null {
  if (!c) return null
  const opt = (o: Record<string, unknown> | undefined, k: string) => (typeof o?.[k] === 'string' ? (o[k] as string) : undefined)
  const all = [c.options, c.broadcastOptions]
  const names = [c.adapter, c.broadcast]
  const kv = names.includes('cloudflare-kv') ? (all.map((o) => opt(o, 'kv_binding')).find((b) => b) ?? 'BRUST_CACHE') : undefined
  const explicitDo = all.map((o) => opt(o, 'do_binding')).find((b) => b)
  const dobind = names.includes('cloudflare-do') || explicitDo !== undefined ? (explicitDo ?? 'BRUST_CACHE_DO') : undefined
  return kv === undefined && dobind === undefined ? null : { ...(kv !== undefined ? { kv } : {}), ...(dobind !== undefined ? { do: dobind } : {}) }
}

function smokeFiles(app: string, cache = false): { preload: string; smoke: string } {
  const preload = `// generated: stubs the Workers-only modules so brust-app.js can be imported under Bun
import { plugin } from 'bun'
plugin({
  name: 'brust-cf-smoke',
  setup(b) {
    b.module('cloudflare:workers', () => ({ exports: { env: {}, waitUntil() {}, DurableObject: class {} }, loader: 'object' }))
  },
})
`
  const smoke = `// generated: build-time smoke check of the CF bundle (child process; mock leaks are process-wide)
const m = await import(${JSON.stringify(app)})
const bad = []
for (const k of ['loader', 'jobs', 'action', 'install']) if (typeof m[k] !== 'function') bad.push(k + ' is not a function')
if (typeof m.MANIFEST !== 'string' || JSON.parse(m.MANIFEST).version !== ${MANIFEST_VERSION}) bad.push('MANIFEST.version !== ${MANIFEST_VERSION}')
if (typeof m.CONFIG !== 'string' || JSON.parse(m.CONFIG).abi !== 1) bad.push('CONFIG.abi !== 1')
if (typeof m.TEMPLATES !== 'object' || m.TEMPLATES === null) bad.push('TEMPLATES is not an object')
const r = await m.loader('{}')
if (typeof r !== 'string' || !r.includes('error')) bad.push('loader({}) did not resolve an error string: ' + String(r))${cache ? `
try {
  const out = m.install({ invalidate: () => ({ l1Removed: 0, jobRemoved: 0 }), l2Count: () => true })
  if (!out || !out.cache || typeof out.cache.origin !== 'string') bad.push('install() returned no cache bridge')
} catch (e) { bad.push('cache adapter: ' + (e && e.message ? e.message : String(e))) }` : ''}
if (bad.length) { console.error(bad.join('\\n')); process.exit(1) }
`
  return { preload, smoke }
}

export async function buildCloudflare(out: string, ctx: CfBuildCtx, p: CfPrepared): Promise<string[]> {
  const cfDir = join(out, 'cf')
  const stage = join(cfDir, '.stage')
  const warnings = [...p.warnings]
  // R10: a Cloudflare cache built-in needs the user's own bindings; verify (never add) before anything is bundled.
  const need = cacheNeeds(ctx.manifest.cache)
  if (need) {
    const v = verifyCacheBindings(p.user.config, need)
    if (!v.ok) throw new BuildError('cf-config', v.message)
  }
  const doClass = need?.do !== undefined
  if (doClass && existsSync(join(p.core.workerDir, 'main.js'))) throw new BuildError('cf-config', `@brust/core-cf ships its own worker/main.js; brust cannot add the BrustCacheDO re-export (R1)`)
  mkdirSync(stage, { recursive: true })
  cpSync(p.core.workerDir, join(cfDir, 'worker'), { recursive: true })

  const templates: Record<string, string> = {}
  for (const [id, c] of Object.entries(ctx.manifest.components)) {
    const comp = ctx.compiled.get(id)
    if (comp) templates[c.template] = comp.jinja
  }
  const templatesPath = join(stage, 'templates.json')
  writeFileSync(templatesPath, JSON.stringify(templates))

  const cors = p.cors
  const a = ctx.manifest.actions
  const cache = ctx.manifest.cache ? { ...ctx.manifest.cache, getTimeoutMs: ctx.cacheGetTimeoutMs ?? 100 } : null
  const entryCache = cache ? cfEntryCache(cache, ctx.cacheModule ?? null) : null
  const config: CfConfigJson = {
    abi: 1,
    generator: `brust/${p.coreVersion}`,
    l1Capacity: p.cfg.l1Capacity,
    jobCacheCapacity: p.cfg.jobCacheCapacity,
    stats: p.cfg.stats,
    edgeCache: p.cfg.edgeCache,
    ...(cors ? { cors } : {}),
    ...(a ? { actions: { prefix: a.prefix, maxBodyBytes: a.maxBodyBytes, maxResponseBytes: a.maxResponseBytes ?? 8_388_608, crossSite: a.crossSite ?? 'reject' } } : {}),
    ...(cache ? { cache: { adapter: cache.adapter, getTimeoutMs: cache.getTimeoutMs, maxBodyBytes: cache.maxBodyBytes, namespace: cache.namespace, buildId: cache.buildId, epochIntervalMs: cache.epochIntervalMs } } : {}),
  }
  const entryPath = join(stage, 'brust-app.entry.js')
  const jobsEntry = join(out, '.stage', 'jobs.ts')
  writeFileSync(
    entryPath,
    cfEntrySource({ entry: ctx.entry, jobsEntry, actionsOnly: ctx.actionsOnly === true, actionsEntry: a ? ctx.actionsEntry : null, prefix: a?.prefix ?? '', manifestPath: join(out, 'manifest.json'), templatesPath, config, cache: entryCache, doClass }),
  )
  // Bare imports of the generated files resolve from the app root (an --out-dir outside the app has no node_modules above it).
  // (registered by absolute AND real path: the bundler reports the real one, e.g. /private/var on macOS)
  for (const f of ctx.actionsOnly ? [entryPath] : [entryPath, jobsEntry]) {
    ctx.sourceOf.set(f, ctx.entry)
    ctx.sourceOf.set(realpathSync(f), ctx.entry)
  }

  const glue = p.core.meta.glue
  const appDir = join(cfDir, 'worker', p.core.meta.appModuleDir)
  const glueRel = relative(appDir, join(cfDir, 'worker', glue)).split('\\').join('/')
  const glueSpec = glueRel.startsWith('.') ? glueRel : `./${glueRel}`
  const violations: string[] = []
  const res = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    format: 'esm',
    conditions: CF_CONDITIONS,
    define: PRODUCTION,
    minify: false,
    external: ['node:*', 'cloudflare:*', glueSpec],
    plugins: [serverOnlyEmptyPlugin(), cssPlugin(ctx.cssMaps ?? new Map(), join(out, 'client')), cfGuard(ctx.appRoot, violations), cfAlias(p.cfg.alias, ctx.sourceOf), cfNativeStub(Bun.resolveSync('@brust/core/server-handlers', ctx.appRoot)), cfStorePlugin(ctx.appRoot), sourceDirPlugin(ctx.sourceOf, ctx.appRoot, ['node:*', 'cloudflare:*'], 'browser', CF_CONDITIONS), exposePlugin(ctx.compiled)],
  })
  if (violations.length > 0) throw new BuildError('cf-unsupported', `${[...new Set(violations)].join('\n')}\nthese modules do not exist on Cloudflare Workers; swap them with [cloudflare] alias`)
  if (!res.success) throw new BuildError('bundle', `cloudflare: ${res.logs.map(String).join('\n')}`)
  const js = res.outputs.filter((o) => o.kind === 'entry-point')
  if (js.length !== 1) throw new BuildError('bundle', `cloudflare: expected one entry-point output, got ${js.length}`)
  for (const o of res.outputs) if (o.kind !== 'entry-point') warnings.push(`[brust] cloudflare bundle: dropped non-JS output ${o.path}`)
  const appFile = join(appDir, 'brust-app.js')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(appFile, await js[0]!.text())

  // An actions-only Worker has no pages and so no Static Assets (no `assets` binding in its wrangler.jsonc either).
  if (!ctx.actionsOnly) warnings.push(...layoutAssets(out, cfDir, p.coreVersion).warnings)
  const compatibilityDate = p.cfg.compatibilityDate ?? p.core.meta.compatibilityDate
  if (compatibilityDate < CF_MIN_COMPAT_DATE) throw new BuildError('config', `compatibility_date ${compatibilityDate} is older than ${CF_MIN_COMPAT_DATE}`)
  if (doClass) {
    // R1: the Durable Object class must be exported by the deployed main module; the glue already imports ./brust-app.js, so it is one module copy.
    const appRel = relative(join(cfDir, 'worker'), appFile).split('\\').join('/')
    writeFileSync(
      join(cfDir, 'worker', 'main.js'),
      `// generated by brust build --target cloudflare (do not edit)\nexport * from "./${p.core.meta.main}"\nexport { default } from "./${p.core.meta.main}"\nexport { BrustCacheDO } from "./${appRel}"\n`,
    )
  }
  const merged = mergeWrangler(p.user, { appRoot: ctx.appRoot, cfDir: join(ctx.dist, 'cf'), name: p.cfg.name, pkgName: p.pkgName, compatibilityDate, main: doClass ? 'main.js' : p.core.meta.main, version: p.coreVersion, ...(ctx.actionsOnly ? { noAssets: true } : {}) })
  warnings.push(...merged.warnings)
  writeFileSync(join(cfDir, 'wrangler.jsonc'), renderWrangler(merged.config))

  const { preload, smoke } = smokeFiles(appFile, cache !== null)
  writeFileSync(join(stage, 'smoke-preload.ts'), preload)
  writeFileSync(join(stage, 'smoke.ts'), smoke)
  const r = Bun.spawnSync([process.execPath, '--preload', join(stage, 'smoke-preload.ts'), join(stage, 'smoke.ts')], {
    cwd: ctx.appRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new BuildError('cf-smoke', `${r.stderr.toString().trim() || r.stdout.toString().trim()}\n(open bindings lazily: module top level runs at build time with env = {})`)
  return warnings
}
