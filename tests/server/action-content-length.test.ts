// F474 (Assets Art B-13): an action sees the Content-Length the client sent, under `brust dev` and under `brust start`.
// The server read the request headers through the response's framing skip-list and dropped it before the worker; the
// dev proxy forwards a sized body with its length and a chunked one without. A chunked request has none to keep, so the
// action sees none (nothing is invented), and the body still arrives. Run alone:
// `bun test --timeout 180000 tests/server/action-content-length.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/action-content-length')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const procs: ReturnType<typeof Bun.spawn>[] = []
let prod = ''
let dev = ''

/** A shell-like env: no NODE_ENV (and none of the BRUST_* the test runner may carry). */
const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', CI: '' }
}

async function ready(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  let log = ''
  const dec = new TextDecoder()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c, { stream: true }) })()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  return `http://${/listening on (\S+)/.exec(out)![1]}`
}

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const start = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  procs.push(start)
  prod = await ready(start)
  const port = (() => { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p })()
  const d = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  procs.push(d)
  dev = `http://localhost:${port}`
  let log = ''
  for (const s of [d.stdout, d.stderr] as ReadableStream<Uint8Array>[]) void (async () => { const dec = new TextDecoder(); for await (const c of s) log += dec.decode(c, { stream: true }) })()
  for (let i = 0; i < 300 && !/\[brust\] ready/.test(log); i++) await Bun.sleep(100)
  if (!/\[brust\] ready/.test(log)) throw new Error(`brust dev not ready:\n${log}`)
}, 180_000)

afterAll(async () => {
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { p.kill('SIGKILL'); await p.exited }
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

type Seen = { contentLength: string | null; transferEncoding: string | null; bytes: number }
const binary = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)
const zip = { 'content-type': 'application/zip' }

for (const [name, base] of [['brust start', () => prod], ['brust dev', () => dev]] as const) {
  test(`${name}: a sized POST and PUT keep the client's Content-Length, the body is intact`, async () => {
    for (const method of ['POST', 'PUT']) {
      const r = await fetch(`${base()}/auth/echo`, { method, headers: zip, body: binary(1024) })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ contentLength: '1024', transferEncoding: null, bytes: 1024 } satisfies Seen)
    }
  })

  test(`${name}: a body past the inline limit (heap path) keeps it too`, async () => {
    const n = 300_000
    const r = await fetch(`${base()}/auth/echo`, { method: 'POST', headers: zip, body: binary(n) })
    expect(await r.json()).toEqual({ contentLength: String(n), transferEncoding: null, bytes: n } satisfies Seen)
  })

  test(`${name}: a chunked POST has no Content-Length (none is invented) and the body still arrives`, async () => {
    const part = binary(512)
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(part); c.enqueue(part); c.close() } })
    const r = await fetch(`${base()}/auth/echo`, { method: 'POST', headers: zip, body, duplex: 'half' } as RequestInit)
    expect(await r.json()).toEqual({ contentLength: null, transferEncoding: null, bytes: 1024 } satisfies Seen)
  })

  test(`${name}: a JSON action sees its Content-Length as well`, async () => {
    const text = JSON.stringify({ a: 1 })
    const r = await fetch(`${base()}/auth/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
    expect(await r.json()).toEqual({ contentLength: String(text.length), body: { a: 1 } })
  })
}
