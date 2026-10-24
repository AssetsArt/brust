// F425: a page that imports a sibling module's `export const el = <b>hi</b>` (a JSX element evaluated at import time).
// `brust start` from a shell has no NODE_ENV when Bun boots, so Bun's runtime transpiler picks the dev JSX transform
// (`jsxDEV`), while run.ts sets NODE_ENV=production for the workers and React's production `react/jsx-dev-runtime` has
// no `jsxDEV`: the worker died at els.tsx with "jsxDEV_… is not a function". The worker now serves a `jsxDEV` of its own
// over the production `jsx`/`jsxs` when it runs in production. `bun test` itself sets NODE_ENV, so the servers here are
// spawned with it removed, like a real shell. Run alone: `bun test --timeout 120000 tests/server/jsx-const-sibling.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/jsx-const-sibling')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const procs: ReturnType<typeof Bun.spawn>[] = []

/** A shell-like env: no NODE_ENV (and none of the BRUST_* the test runner may carry). */
const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
}

async function serve(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([bin, ...args], { cwd: app, env: { ...shellEnv(), ...extra }, stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust ${args.join(' ')} exited before ready:\n${out}\n${await new Response(proc.stderr as ReadableStream).text()}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  return `http://${/listening on (\S+)/.exec(out)![1]}`
}

beforeAll(() => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}, 120_000)

afterAll(async () => {
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { p.kill('SIGKILL'); await p.exited }
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('brust start (no NODE_ENV at boot) serves a page whose sibling module holds a JSX const', async () => {
  const base = await serve(['start', '--port', '0', '--workers', '1'])
  const res = await fetch(`${base}/`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('<p data-testid="p"><b>hi</b></p>')
}, 60_000)

test('the same with NODE_ENV=production already set', async () => {
  const base = await serve(['start', '--port', '0', '--workers', '1'], { NODE_ENV: 'production' })
  const res = await fetch(`${base}/`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('<b>hi</b>')
}, 60_000)

test('brust dev serves it too', async () => {
  const port = (() => { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p })()
  const proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], { cwd: app, env: { ...shellEnv(), CI: '' }, stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  let log = ''
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) void (async () => { const dec = new TextDecoder(); for await (const c of s) log += dec.decode(c, { stream: true }) })()
  for (let i = 0; i < 100 && !/\[brust\] ready/.test(log); i++) await Bun.sleep(100)
  expect(log).toContain('[brust] ready')
  const res = await fetch(`http://localhost:${port}/`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('<b>hi</b>')
}, 60_000)

test('brust build --target static prerenders it', async () => {
  const out = join(app, 'dist-static')
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static', '--out-dir', out], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  expect(b.exitCode).toBe(0)
  expect(await Bun.file(join(out, 'static', 'index.html')).text()).toContain('<p data-testid="p"><b>hi</b></p>')
  rmSync(out, { recursive: true, force: true })
}, 60_000)
