// `brust start` / `bun dist/index.js`: boot the Rust server, spawn N Bun workers that answer
// `loader`/`jobs` (worker.ts), wait for them to register, then live until a signal.
// SIGINT/SIGTERM → graceful drain (bounded by drainTimeoutMs) → exit 0; a second signal exits at
// once (130 / 143); a signal before every worker registered exits 0 at once (nothing is being
// served yet, and the server's drain only starts once it accepts). A worker that dies (error,
// process.exit, OOM) → drain → exit 1: M2 does not respawn, the supervisor restarts the process.
// Nothing here returns on its own: a started server keeps the process alive and a drained one
// does not end it, so every exit is an explicit `process.exit`.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type BrustConfig, type ConfigOverrides, loadConfig } from './config'
import { beginDrain, type StartOptions, startServer, untilReady } from './native'
import { DEFAULT_MAX_LOADER_RESPONSE_BYTES } from './worker'

export interface RunOptions {
  distDir?: string
  /** The routes module the workers import (`export const routes` or default). */
  entry?: string
  /** Overrides below env (CLI flags): see config.ts (incl. `bootTimeoutMs`, default 30000). */
  config?: ConfigOverrides
}

/** The manifest fields `run` needs (build/manifest.ts owns the full shape). */
export interface RunManifest {
  actions?: { entry: string; prefix: string; maxBodyBytes: number; maxResponseBytes?: number; crossSite?: 'reject' | 'allow' } | null
  /** `[cache]`: the server's L2 settings (the workers load the adapter itself). */
  cache?: { adapter: string; getTimeoutMs: number; maxBodyBytes: number; namespace: string; buildId: string } | null
}

/** Pure: the napi `StartOptions`. No actions/cors/cache → exactly the pre-actions keys. */
export function startOptions(cfg: BrustConfig, distDir: string, m: RunManifest, version: string): StartOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    distDir,
    workers: cfg.workers,
    callTimeoutMs: cfg.callTimeoutMs,
    ...(cfg.maxLoaderResponseBytes !== undefined && cfg.maxLoaderResponseBytes !== DEFAULT_MAX_LOADER_RESPONSE_BYTES ? { maxLoaderResponseBytes: cfg.maxLoaderResponseBytes } : {}),
    workerThreads: cfg.ioThreads,
    generator: `brust/${version}`,
    ...(m.actions ? { actions: { prefix: m.actions.prefix, maxBodyBytes: m.actions.maxBodyBytes, ...(m.actions.maxResponseBytes !== undefined ? { maxResponseBytes: m.actions.maxResponseBytes } : {}), ...(m.actions.crossSite ? { crossSite: m.actions.crossSite } : {}) } } : {}),
    ...(cfg.cors ? { cors: cfg.cors } : {}),
    ...(m.cache ? { l2: { adapter: m.cache.adapter, getTimeoutMs: m.cache.getTimeoutMs, maxBodyBytes: m.cache.maxBodyBytes, namespace: m.cache.namespace, buildId: m.cache.buildId } } : {}),
  }
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
  if (!existsSync(entry)) fail(`routes entry ${entry} not found`)

  let cfg: BrustConfig
  try {
    cfg = await loadConfig(process.cwd(), opts.config)
  } catch (e) {
    fail((e as Error).message)
  }

  const version: string = (await Bun.file(join(import.meta.dir, '../package.json')).json()).version
  try {
    startServer(startOptions(cfg, distDir, m, version))
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

  const url = new URL('./worker.ts', import.meta.url)
  for (let i = 0; i < cfg.workers; i++) {
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
  console.log(`[brust] ready (${cfg.workers} worker${cfg.workers === 1 ? '' : 's'})`)
  await new Promise<never>(() => {})
}
