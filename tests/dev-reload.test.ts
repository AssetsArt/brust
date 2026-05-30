import { afterEach, expect, test } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Regression: dev-mode browser auto-reload over the /_brust/dev WebSocket.
 *
 * Two bugs this guards against, both reproduced by hand before the fix:
 *
 *  B — `reload` lost across a worker restart. The coordinator broadcasts
 *      `reload` AFTER terminateAll()/spawnAll(); the connection's registration
 *      died with the old worker, so the message hit workers with no clients and
 *      vanished. The browser only ever received `building`, never `reload`.
 *
 *  C — UAF segfault. The dev WS connection's on_close tsfn belonged to a worker
 *      that a hot reload terminated. When the socket later closed, Rust invoked
 *      the freed tsfn and the whole dev server crashed (SIGSEGV).
 *
 * The fix makes /_brust/dev a Rust/main-thread-owned control channel that
 * survives worker restarts (no worker tsfn, broadcast sent directly via the
 * Rust-owned send_tx). This test drives the real `brust dev` server. */

const REPO_ROOT = resolve(import.meta.dir, '..')
const ENTRY = resolve(REPO_ROOT, 'tests/fixtures/app/index.ts')
const SCAN_ROOT = resolve(REPO_ROOT, 'tests/fixtures/app')
const PROBE = resolve(SCAN_ROOT, '__reload_probe__.tsx')
const PORT = 3811
const BASE = `http://127.0.0.1:${PORT}`

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

async function waitForReady(timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/ping`)
      if (r.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`dev server not ready at ${BASE}: ${String(lastErr)}`)
}

test('dev: WS client receives reload across a ts hot reload and the server survives', async () => {
  proc = spawn({
    cmd: ['bun', 'runtime/cli/index.ts', 'dev', ENTRY, '--port', String(PORT)],
    cwd: REPO_ROOT,
    env: { ...process.env, BRUST_NO_TUI: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForReady()

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

  // Trigger a 'ts' hot reload: a throwaway .tsx under scanRoot makes the
  // watcher fire terminateAll()/spawnAll() — the exact path that drops the
  // reload (B) and dangles the WS tsfn (C).
  writeFileSync(PROBE, `export const probe = ${Date.now()}\n`)

  // B: the browser must actually receive `reload`.
  expect(await gotReload).toBe(true)

  // C: closing the WS after the worker restart must not crash the server.
  ws.close()
  await new Promise((r) => setTimeout(r, 1500))
  const ping = await fetch(`${BASE}/ping`)
  expect(ping.status).toBe(200)
}, 40000)

test('dev: native (jinja) route HTML includes the /_brust/dev client script', async () => {
  // A: native routes render Rust-side (the fast lane), bypassing the React
  // renderer that injects the dev client. Without injecting it at jinja-emit
  // time, a native page never opens the dev WS, so it can never auto-reload —
  // the user sees "content changed but I had to reload the page myself".
  proc = spawn({
    cmd: ['bun', 'runtime/cli/index.ts', 'dev', ENTRY, '--port', String(PORT)],
    cwd: REPO_ROOT,
    env: { ...process.env, BRUST_NO_TUI: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForReady()

  const html = await (await fetch(`${BASE}/_test/native/alice`)).text()
  expect(html).toContain('/_brust/dev')
}, 40000)
