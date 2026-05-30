import { afterEach, expect, test } from 'bun:test'
import { type Subprocess, spawn } from 'bun'
import { resolve } from 'node:path'

/** `brust.run({ address, port })` + the localhost:1337 defaults. Drives the real
 * fixture server: the bound address shows up in the `listening on …` log, which
 * proves the host actually reached Rust's bind (a hardcoded 127.0.0.1 would log
 * 127.0.0.1 even when 0.0.0.0 was requested). */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE = resolve(REPO_ROOT, 'tests/fixtures/app/index.ts')

let proc: Subprocess | undefined
let stdout = ''

afterEach(() => {
  proc?.kill('SIGINT')
  proc = undefined
  stdout = ''
})

/** Spawn the fixture, accumulating stdout, and wait until it logs `listening on`
 * (or times out). Returns the captured stdout. */
async function spawnAndAwaitListen(
  env: Record<string, string>,
  timeoutMs = 15000,
): Promise<string> {
  proc = spawn({
    cmd: ['bun', 'run', FIXTURE],
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    stdout += dec.decode(value, { stream: true })
    if (stdout.includes('listening on')) break
  }
  reader.releaseLock()
  return stdout
}

async function reachable(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.status === 200) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function envWithout(...drop: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !drop.includes(k)),
  ) as Record<string, string>
}

test('defaults to localhost:1337 when no address/port configured', async () => {
  const log = await spawnAndAwaitListen(envWithout('BRUST_PORT', 'BRUST_ADDR'))
  expect(log).toContain('listening on 127.0.0.1:1337')
  expect(await reachable('http://127.0.0.1:1337/ping')).toBe(true)
}, 30000)

test('binds the configured address (0.0.0.0 reaches Rust, not hardcoded 127.0.0.1)', async () => {
  const log = await spawnAndAwaitListen({
    ...envWithout('BRUST_PORT', 'BRUST_ADDR'),
    BRUST_ADDR: '0.0.0.0',
    BRUST_PORT: '38211',
  })
  expect(log).toContain('listening on 0.0.0.0:38211')
  expect(await reachable('http://127.0.0.1:38211/ping')).toBe(true)
}, 30000)
