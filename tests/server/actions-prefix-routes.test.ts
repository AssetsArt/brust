// Page and loader routes under the actions prefix (F470, Assets Art B-12) against
// packages/brust/test/fixtures/actions-prefix-routes served by `brust start`: [actions] prefix = "/auth", a loader route
// /auth/{provider}/callback that sets a cookie and redirects, and actions at /auth/:provider/callback (POST),
// /auth/:provider/start (GET, no route) and /auth/google/callback (GET, shadowed by the route: a boot warning names it).
// Run alone: `bun test --timeout 300000 tests/server/actions-prefix-routes.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/actions-prefix-routes')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let log = ''

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  const dec = new TextDecoder()
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c) })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  log += out
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; log += dec.decode(value) } })()
}, 240_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const req = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: 'manual', ...init })

test('GET of a loader route under the prefix is the route: its cookie and its redirect', async () => {
  const r = await req('/auth/google/callback?code=abc')
  expect(r.status).toBe(303)
  expect(r.headers.get('location')).toBe('/')
  expect(r.headers.getSetCookie()).toEqual(['sid=google-abc; Path=/; HttpOnly; SameSite=Lax'])
  const h = await req('/auth/github/callback', { method: 'HEAD' })
  expect(h.status).toBe(303)
  const p = await req('/auth/done')
  expect(p.status).toBe(200)
  expect(await p.text()).toContain('data-page="auth-done"')
})

test('a POST at the same path is the action (Apple form_post); a GET no route matches is the action too', async () => {
  const post = await req('/auth/apple/callback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=x' })
  expect(post.status).toBe(200)
  expect(await post.json()).toEqual({ action: 'callback', provider: 'apple' })
  const start = await req('/auth/google/start')
  expect(start.status).toBe(200)
  expect(await start.json()).toEqual({ action: 'start', provider: 'google' })
})

test('the catch-all does not take a path under the prefix; outside it, it is the 404 page', async () => {
  const under = await req('/auth/nothing/here/at/all')
  expect(under.status).toBe(404)
  expect(await under.text()).not.toContain('data-page="not-found"')
  const outside = await req('/nothing')
  expect(outside.status).toBe(404)
  expect(await outside.text()).toContain('data-page="not-found"')
})

test('boot warns once about the GET action the route shadows', async () => {
  expect(log.match(/these GET actions are never reached: GET \/auth\/google\/callback \(route \/auth\/\{provider\}\/callback\)/g)?.length).toBe(1)
  expect(log).not.toContain('/auth/:provider/start (route')
})
