// F604: calls complete through the slot's completion cell (`callDone`). Under load, with clients that give up
// mid-call, every answered response carries ITS OWN request's marker (no slot handed to the next call while the
// worker may still write it), and nothing hangs.
// Run alone: `bun test --timeout 120000 tests/server/call-done.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/call-done')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('2,000 requests at c=32, every 5th abandoned mid-call: each answer is its own, none hangs', async () => {
  const N = 2000
  const C = 32
  let next = 0
  let answered = 0
  let aborted = 0
  const wrong: string[] = []
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= N) return
      const marker = `m${i}x${Math.random().toString(36).slice(2, 8)}`
      const ctl = new AbortController()
      if (i % 5 === 0) setTimeout(() => ctl.abort(), Math.random() * 6)
      try {
        const res = await fetch(`${base}/echo/${marker}`, { signal: ctl.signal })
        const body = await res.text()
        if (res.status !== 200 || !body.includes(`<p id="m">${marker}</p>`)) wrong.push(`${marker}: ${res.status} ${body.slice(0, 120)}`)
        else answered++
      } catch (e) {
        if ((e as Error).name !== 'AbortError') wrong.push(`${marker}: ${String(e)}`)
        else aborted++
      }
    }
  }
  const t0 = performance.now()
  await Promise.all(Array.from({ length: C }, worker))
  const ms = performance.now() - t0
  console.log(`F604 call-done: ${answered} answered, ${aborted} aborted, ${wrong.length} wrong, ${Math.round(ms)} ms`)
  expect(wrong).toEqual([])
  expect(answered + aborted).toBe(N)
  expect(aborted).toBeGreaterThan(0)
  // The abandoned calls' slots came back: a fresh round still answers, quickly.
  const after = await Promise.all(Array.from({ length: 64 }, (_, i) => fetch(`${base}/echo/after${i}`).then((r) => r.text())))
  after.forEach((b, i) => expect(b).toContain(`<p id="m">after${i}</p>`))
}, 120_000)
