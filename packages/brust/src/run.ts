// `brust start` / `bun dist/index.js`: boot the Rust server, spawn N Bun workers that answer
// `loader`/`jobs` (worker.ts), wait for them to register, then live until a signal.
// SIGINT/SIGTERM → graceful drain (bounded by drainTimeoutMs) → exit 0; a second signal exits at
// once (130 / 143); a signal before every worker registered exits 0 at once (nothing is being
// served yet, and the server's drain only starts once it accepts). A worker that dies (error,
// process.exit, OOM) → drain → exit 1: M2 does not respawn, the supervisor restarts the process.
// F165: a build whose manifest says `needs_workers: false` (no loader, job, actions app or cache
// adapter) spawns none; the server then serves at once and a stray worker call answers 503.
// Nothing here returns on its own: a started server keeps the process alive and a drained one
// does not end it, so every exit is an explicit `process.exit`.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type BrustConfig, type ConfigOverrides, loadConfig } from './config'
import { beginDrain, localAddr, type StartOptions, type StreamOptions, startServer, untilReady } from './native'
import { DEFAULT_MAX_LOADER_RESPONSE_BYTES } from './worker'

export interface RunOptions {
  distDir?: string
  /** The routes module the workers import (`export const routes` or default). */
  entry?: string
  /** Overrides below env (CLI flags): see config.ts (incl. `bootTimeoutMs`, default 30000). */
  config?: ConfigOverrides
  /** Static output (gaps round L9): runs once every worker is ready, with the bound `host:port`;
   * then the server drains and the process exits with the returned code. */
  onReady?: (addr: string) => Promise<number>
}

/** The manifest fields `run` needs (build/manifest.ts owns the full shape). */
export interface RunManifest {
  actions?: { entry: string; prefix: string; maxBodyBytes: number; maxResponseBytes?: number; crossSite?: 'reject' | 'allow' } & StreamKeys | null
  /** L16 R16.3: `brust build --actions-only`: no page routes and no routes entry. */
  actions_only?: boolean
  /** L16 R16.4b: a page-only build; the actions app is deployed elsewhere (`[actions] base_url`). */
  actions_remote?: { prefix: string } | null
  /** `[cache]`: the server's L2 settings (the workers load the adapter itself). */
  cache?: { adapter: string; getTimeoutMs: number; maxBodyBytes: number; namespace: string; buildId: string } | null
  /** F165: `false` = no route can call a worker; absent (older manifests) = the pool is needed. */
  needs_workers?: boolean
}

/** F475: the `[actions] stream` keys of `manifest.actions`, passed to napi as they are. */
type StreamKeys = Pick<StreamOptions, 'stream' | 'maxStreamBytes' | 'streamIdleMs' | 'streamTotalMs' | 'maxStreams'>

/** F475: the stream keys `a` carries; none without a `stream` list, so an app without one starts as before. */
function streamOptions(a: StreamKeys): StreamKeys {
  if (!a.stream?.length) return {}
  const { stream, maxStreamBytes, streamIdleMs, streamTotalMs, maxStreams } = a
  return { stream, maxStreamBytes, streamIdleMs, streamTotalMs, ...(maxStreams !== undefined ? { maxStreams } : {}) }
}

/** F165 (R40.1): the pool size `run` spawns: none only when the build said no request needs one. */
export function workerCount(cfg: BrustConfig, m: RunManifest): number {
  return m.needs_workers === false ? 0 : cfg.workers
}

/** Pure: the napi `StartOptions`. No actions/cors/cache → exactly the pre-actions keys. */
export function startOptions(cfg: BrustConfig, distDir: string, m: RunManifest, version: string, devToken?: string): StartOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    distDir,
    workers: workerCount(cfg, m),
    callTimeoutMs: cfg.callTimeoutMs,
    ...(cfg.maxLoaderResponseBytes !== undefined && cfg.maxLoaderResponseBytes !== DEFAULT_MAX_LOADER_RESPONSE_BYTES ? { maxLoaderResponseBytes: cfg.maxLoaderResponseBytes } : {}),
    workerThreads: cfg.ioThreads,
    generator: `brust/${version}`,
    ...(m.actions ? { actions: { prefix: m.actions.prefix, maxBodyBytes: m.actions.maxBodyBytes, ...(m.actions.maxResponseBytes !== undefined ? { maxResponseBytes: m.actions.maxResponseBytes } : {}), ...(m.actions.crossSite ? { crossSite: m.actions.crossSite } : {}), ...streamOptions(m.actions) } } : {}),
    ...(actionsClient(cfg, m) ? { actionsClient: actionsClient(cfg, m) } : {}),
    ...(cfg.cors ? { cors: cfg.cors } : {}),
    ...(devToken ? { devToken } : {}),
    ...(m.cache ? { l2: { adapter: m.cache.adapter, getTimeoutMs: m.cache.getTimeoutMs, maxBodyBytes: m.cache.maxBodyBytes, namespace: m.cache.namespace, buildId: m.cache.buildId } } : {}),
  }
}

/** L16: what the page tells the browser `client()` (R16.1/R16.2); absent while it would only repeat the prefix script. */
function actionsClient(cfg: BrustConfig, m: RunManifest): NonNullable<StartOptions['actionsClient']> | undefined {
  const credentials = cfg.actionsCredentials !== undefined && cfg.actionsCredentials !== 'same-origin' ? cfg.actionsCredentials : undefined
  if (cfg.actionsBaseUrl === undefined && credentials === undefined && !m.actions_remote) return undefined
  const prefix = m.actions?.prefix ?? m.actions_remote?.prefix
  return { ...(prefix ? { prefix } : {}), ...(cfg.actionsBaseUrl !== undefined ? { baseUrl: cfg.actionsBaseUrl } : {}), ...(credentials ? { credentials } : {}) }
}

/** Every worker's response buffer, kept reachable until the process exits (see run()). */
const workerBuffers: SharedArrayBuffer[] = []

function fail(msg: string): never {
  console.error(`[brust] ${msg}`)
  process.exit(1)
}

export async function run(opts: RunOptions = {}): Promise<void> {
  // env > flags, as every other setting (config.ts); an empty env var counts as unset.
  const distDir = resolve(process.env.BRUST_DIST_DIR || opts.distDir || 'dist')
  const manifest = join(distDir, 'manifest.json')
  if (!existsSync(manifest)) fail(`run brust build first (${manifest} not found)`)
  let m: RunManifest
  try {
    m = JSON.parse(readFileSync(manifest, 'utf8')) as RunManifest
  } catch (e) {
    fail(`bad manifest ${manifest}: ${(e as Error).message}`)
  }
  const entry = resolve(process.env.BRUST_APP_ENTRY || opts.entry || 'routes.tsx')
  // R16.3: an actions-only dist has no pages, so no routes module either.
  if (!m.actions_only && !existsSync(entry)) fail(`routes entry ${entry} not found`)

  let cfg: BrustConfig
  try {
    cfg = await loadConfig(process.cwd(), opts.config)
  } catch (e) {
    fail((e as Error).message)
  }

  if (m.actions_remote && cfg.actionsBaseUrl === undefined)
    fail('this build has no local actions app: set [actions] base_url (or BRUST_ACTIONS_BASE_URL) to the deployment that serves them')
  const version: string = (await Bun.file(join(import.meta.dir, '../package.json')).json()).version
  try {
    startServer(startOptions(cfg, distDir, m, version, process.env.BRUST_DEV_TOKEN || undefined))
  } catch (e) {
    fail((e as Error).message)
  }

  // React (external in jobs.js) picks its production build from NODE_ENV at import time; an
  // explicitly set NODE_ENV is kept.
  process.env.NODE_ENV ??= 'production'
  // Bun workers share the process env; each gets its id + the boot inputs (worker.ts startWorker).
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV,
    BRUST_RENDER_SLOTS: String(cfg.renderSlots),
    BRUST_SLOT_BYTES: String(cfg.slotBytes),
    BRUST_MAX_LOADER_RESPONSE_BYTES: String(cfg.maxLoaderResponseBytes),
    BRUST_DIST_DIR: distDir,
    BRUST_APP_ENTRY: entry,
    // One cache-adapter origin per process: its workers' published events are not replayed here.
    BRUST_CACHE_ORIGIN: crypto.randomUUID(),
  }

  let ready = false
  let draining = false
  let failed = false
  let exiting = false
  const exit = (code: number): never => {
    exiting = true
    process.exit(code)
  }
  /** Drain (only once accepting: before that the server's drain never completes), then exit —
   * non-zero if a worker died meanwhile. */
  const drainThenExit = (code: number) => {
    draining = true
    if (!ready) exit(code)
    beginDrain(cfg.drainTimeoutMs)
      .catch((e) => console.error(`[brust] drain: ${String(e)}`))
      .finally(() => exit(failed ? 1 : code))
  }

  const workers = workerCount(cfg, m)
  const url = new URL('./worker.ts', import.meta.url)
  for (let i = 0; i < workers; i++) {
    // The response buffer is owned HERE, for the process lifetime: the Rust dispatcher keeps a raw
    // pointer into it, so it must not be freed with the worker (crates/brust-napi dispatch.rs).
    const sab = new SharedArrayBuffer(cfg.slotBytes * cfg.renderSlots)
    workerBuffers.push(sab)
    const w = new Worker(url, { env: { ...env, BRUST_WORKER_ID: String(i) }, workerData: { sab } } as WorkerOptions)
    // No respawn in M2: a worker that fails to boot or dies later takes the process down loudly
    // instead of leaving the server answering 503 for every loader/job route.
    w.addEventListener('error', (e) => {
      if (exiting) return
      console.error(`[brust] worker ${i}: ${(e as ErrorEvent).message} — shutting down`)
      failed = true
      if (!draining) drainThenExit(1)
    })
    w.addEventListener('close', (e) => {
      if (exiting) return
      console.error(`[brust] worker ${i} exited (code ${(e as CloseEvent).code}) — shutting down`)
      failed = true
      if (!draining) drainThenExit(1)
    })
  }

  const onSignal = (code: number) => {
    if (draining) exit(code)
    drainThenExit(0)
  }
  // Ruling 2bf3775a (R3): an app error that escapes to the main thread is fatal — log, drain,
  // exit non-zero; no respawn in M2 (the supervisor restarts the process).
  const onFatal = (kind: string) => (err: unknown) => {
    if (exiting) return
    console.error(`[brust] ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)} — shutting down`)
    failed = true
    if (!draining) drainThenExit(1)
  }
  process.on('uncaughtException', onFatal('uncaught exception'))
  process.on('unhandledRejection', onFatal('unhandled rejection'))
  process.on('SIGINT', () => onSignal(130))
  process.on('SIGTERM', () => onSignal(143))

  try {
    await untilReady(cfg.bootTimeoutMs)
  } catch (e) {
    fail(`workers not ready: ${String((e as Error).message ?? e)} (BRUST_BOOT_TIMEOUT_MS=${cfg.bootTimeoutMs})`)
  }
  ready = true
  console.log(`[brust] ready (${workers} worker${workers === 1 ? '' : 's'})`)
  if (opts.onReady) {
    let code = 1
    try {
      code = await opts.onReady(localAddr())
    } catch (e) {
      console.error(`[brust] ${(e as Error).stack ?? String(e)}`)
    }
    if (!draining) drainThenExit(code)
  }
  await new Promise<never>(() => {})
}
