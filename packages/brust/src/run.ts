// `brust start` / `bun dist/index.js`: boot the Rust server, spawn N Bun workers that answer
// `loader`/`jobs` (worker.ts), wait for them to register, then live until a signal.
// SIGINT/SIGTERM → graceful drain (bounded by drainTimeoutMs) → exit 0; a second signal exits at
// once (130 / 143). Nothing here returns on its own: a started server keeps the process alive and
// a drained one does not end it, so every exit is an explicit `process.exit`.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type BrustConfig, loadConfig } from './config'
import { beginDrain, startServer, untilReady } from './native'

export interface RunOptions {
  distDir?: string
  /** The routes module the workers import (`export const routes` or default). */
  entry?: string
  /** Overrides below env (CLI flags): see config.ts. */
  config?: Partial<BrustConfig>
  /** How long to wait for every worker to register. Default 5000. */
  bootTimeoutMs?: number
}

function fail(msg: string): never {
  console.error(`[brust] ${msg}`)
  process.exit(1)
}

export async function run(opts: RunOptions = {}): Promise<void> {
  const distDir = resolve(opts.distDir ?? process.env.BRUST_DIST_DIR ?? 'dist')
  const manifest = join(distDir, 'manifest.json')
  if (!existsSync(manifest)) fail(`run brust build first (${manifest} not found)`)
  const entry = resolve(opts.entry ?? process.env.BRUST_APP_ENTRY ?? 'routes.tsx')
  if (!existsSync(entry)) fail(`routes entry ${entry} not found`)

  let cfg: BrustConfig
  try {
    cfg = await loadConfig(process.cwd(), opts.config)
  } catch (e) {
    fail((e as Error).message)
  }

  const version: string = (await Bun.file(join(import.meta.dir, '../package.json')).json()).version
  try {
    startServer({ host: cfg.host, port: cfg.port, distDir, workers: cfg.workers, generator: `brust/${version}` })
  } catch (e) {
    fail((e as Error).message)
  }

  // Bun workers share the process env; each gets its id + the boot inputs (worker.ts startWorker).
  const env = {
    ...process.env,
    BRUST_RENDER_SLOTS: String(cfg.renderSlots),
    BRUST_DIST_DIR: distDir,
    BRUST_APP_ENTRY: entry,
  }
  const url = new URL('./worker.ts', import.meta.url)
  for (let i = 0; i < cfg.workers; i++) {
    const w = new Worker(url, { env: { ...env, BRUST_WORKER_ID: String(i) } })
    // No respawn in M2: a worker that fails to boot (or dies later) takes the process down loudly
    // instead of leaving the server waiting on a slot nobody answers.
    w.addEventListener('error', (e) => fail(`worker ${i}: ${(e as ErrorEvent).message}`))
  }

  let draining = false
  const onSignal = (code: number) => {
    if (draining) process.exit(code)
    draining = true
    beginDrain(cfg.drainTimeoutMs)
      .catch((e) => console.error(`[brust] drain: ${String(e)}`))
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', () => onSignal(130))
  process.on('SIGTERM', () => onSignal(143))

  try {
    await untilReady(opts.bootTimeoutMs ?? 5000)
  } catch (e) {
    fail(`workers not ready: ${String((e as Error).message ?? e)}`)
  }
  await new Promise<never>(() => {})
}
