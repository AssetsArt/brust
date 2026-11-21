// F604 Step 0 (c): what a request sees when its worker exits while the call is in flight. Pins today's outcome
// so the call-done change (completion through callDone instead of the worker's Promise) keeps it.
// Run alone: `bun test --timeout 120000 tests/server/worker-exit.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/worker-exit')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let out = ''
let err = ''

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_CALL_TIMEOUT_MS: '3000' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) err += new TextDecoder().decode(c) })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; out += dec.decode(value) } })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGKILL')
  await proc?.exited
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

// Today (napi Promise conversion): Bun finalizes the pending call when the worker's env goes away, the oneshot
// sender drops and Rust sees a rejection ('oneshot canceled'): 500 at once, long before the call deadline (3 s).
test('a worker that exits mid-call: 500 at once (not the deadline), the process drains and exits non-zero', async () => {
  expect((await fetch(`${base}/ok`)).status).toBe(200)
  const t0 = performance.now()
  const r = await fetch(`${base}/exit`, { signal: AbortSignal.timeout(40_000) }).then(
    async (res) => ({ status: res.status, body: (await res.text()).slice(0, 200) }),
    (e) => ({ status: -1, body: String(e) }),
  )
  const ms = Math.round(performance.now() - t0)
  const code = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => 'running')])
  console.log(`F604 worker-exit: status=${r.status} after ${ms} ms body=${JSON.stringify(r.body)} process=${code}`)
  expect(r.status).toBe(500)
  expect(ms).toBeLessThan(2500)
  expect(code).not.toBe('running')
  expect(code).not.toBe(0)
}, 90_000)
