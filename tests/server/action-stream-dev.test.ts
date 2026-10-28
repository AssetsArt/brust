// F475 lane B: the `brust dev` proxy admits a streamed upload. Bun.serve's default `maxRequestBodySize` (128 MiB) refused
// a body the child admits (`max_stream_bytes` = 192 MiB here), and its 10 s idle timeout cut an upload that paused.
// A 160 MiB chunked upload reaches the action byte-exact through the proxy; so does one that pauses 13 s mid-body.
// Run alone: `bun test --timeout 300000 tests/server/action-stream-dev.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/action-stream-dev')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const MiB = 1 << 20
let proc: ReturnType<typeof Bun.spawn>
let base = ''

const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', CI: '' }
}

beforeAll(async () => {
  const port = (() => {
    const s = Bun.serve({ port: 0, fetch: () => new Response('') })
    const p = s.port as number
    s.stop(true)
    return p
  })()
  proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  base = `http://localhost:${port}`
  let log = ''
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[])
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of s) log += dec.decode(c, { stream: true })
    })()
  for (let i = 0; i < 600 && !/\[brust\] ready/.test(log); i++) await Bun.sleep(100)
  if (!/\[brust\] ready/.test(log)) throw new Error(`brust dev not ready:\n${log}`)
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if (proc && (await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
})

/** Chunk `i` of 1 MiB, deterministic. */
function chunk(i: number): Uint8Array {
  const c = new Uint8Array(MiB)
  let x = (i * 2654435761) >>> 0
  for (let k = 0; k < MiB; k += 4) {
    x = (x * 1664525 + 1013904223) >>> 0
    c[k] = x
    c[k + 1] = x >>> 8
    c[k + 2] = x >>> 16
    c[k + 3] = x >>> 24
  }
  return c
}

/** POST `n` MiB as a chunked body; `pauseAt`/`pauseMs` stall the stream once mid-body. Returns the action's answer and the sender's SHA-256. */
async function upload(n: number, pause?: { at: number; ms: number }) {
  const sent = createHash('sha256')
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (pause && i === pause.at) await Bun.sleep(pause.ms)
      if (i >= n) return c.close()
      const b = chunk(i++)
      sent.update(b)
      c.enqueue(b)
    },
  })
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' } as RequestInit)
  return { status: r.status, answer: (await r.json()) as { bytes: number; sha256: string }, sha256: sent.digest('hex') }
}

test('a 160 MiB streamed upload (past the proxy\'s old 128 MiB limit) reaches the action byte-exact', async () => {
  const r = await upload(160)
  expect(r.status).toBe(200)
  expect(r.answer.bytes).toBe(160 * MiB)
  expect(r.answer.sha256).toBe(r.sha256)
}, 300_000)

test('an upload that pauses 13 s mid-body (past Bun\'s 10 s idle timeout) is not cut', async () => {
  const r = await upload(4, { at: 2, ms: 13_000 })
  expect(r.status).toBe(200)
  expect(r.answer.bytes).toBe(4 * MiB)
  expect(r.answer.sha256).toBe(r.sha256)
}, 120_000)
