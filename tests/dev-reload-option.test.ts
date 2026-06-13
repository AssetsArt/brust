import { afterEach, expect, test } from 'bun:test'
import { type Subprocess, spawn } from 'bun'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Regression: hot reload under the PROGRAMMATIC dev path `brust.run({ dev: true })`.
 *
 * The `brust dev` CLI sets BRUST_DEV=1, but `run({ dev: true })` (called directly,
 * e.g. an app's own entry) did not. serve()'s worker-registry registerInitialPool
 * gated ONLY on `process.env.BRUST_DEV === '1'`, while the dev coordinator/watcher
 * gated on the broader `dev = opts.dev || env` flag. So the watcher was live but
 * the pool was never registered, and the first hot reload threw:
 *   "worker-registry: spawnAll called before registerInitialPool"
 * — `reload` was never broadcast and the workers never came back.
 *
 * run() now sets BRUST_DEV=1 whenever dev is enabled by either signal. This test
 * spawns the fixture ENTRY DIRECTLY (bypassing the CLI) with dev enabled via the
 * option only, scrubbing BRUST_DEV from the env, then triggers a hot reload. */

const REPO_ROOT = resolve(import.meta.dir, '..')
const ENTRY = resolve(REPO_ROOT, 'tests/fixtures/app/index.ts')
const SCAN_ROOT = resolve(REPO_ROOT, 'tests/fixtures/app')
const PROBE = resolve(SCAN_ROOT, '__reload_opt_probe__.tsx')

let proc: Subprocess | undefined

afterEach(() => {
  try {
    rmSync(PROBE, { force: true })
  } catch {
    /* ignore */
  }
  proc?.kill('SIGINT')
  proc = undefined
})

async function waitForReady(base: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/ping`)
      if (r.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`dev server not ready at ${base}: ${String(lastErr)}`)
}

test('run({ dev: true }) without BRUST_DEV: hot reload spawnAll succeeds (pool was registered)', async () => {
  const PORT = 3819
  const BASE = `http://127.0.0.1:${PORT}`
  // dev enabled ONLY via the option; BRUST_DEV deliberately absent so the test
  // proves run() self-sets it.
  const env: Record<string, string | undefined> = {
    ...process.env,
    BRUST_TEST_DEV_OPTION: '1',
    BRUST_PORT: String(PORT),
    BRUST_NO_TUI: '1',
  }
  delete env.BRUST_DEV
  proc = spawn({
    cmd: ['bun', ENTRY],
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForReady(BASE)

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_brust/dev`)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('dev WS failed to open'))
  })

  const gotReload = new Promise<boolean>((res) => {
    ws.onmessage = (e) => {
      try {
        if (JSON.parse(String(e.data)).type === 'reload') res(true)
      } catch {
        /* ignore non-JSON */
      }
    }
    setTimeout(() => res(false), 10000)
  })

  // Trigger a 'ts' hot reload → coordinator terminateAll()/spawnAll(). The
  // 'reload' broadcast only happens AFTER spawnAll() resolves, so receiving it
  // proves the pool was registered (the bug threw before this point).
  writeFileSync(PROBE, `export const probe = ${Date.now()}\n`)
  expect(await gotReload).toBe(true)

  // And the freshly respawned pool actually serves.
  expect((await fetch(`${BASE}/ping`)).status).toBe(200)
  ws.close()
}, 30000)
