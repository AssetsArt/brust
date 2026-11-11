// F529: WebSockets in an actions app, served by `brust start --workers 2` under `[server] base_path = "/app"`
// (packages/brust/test/fixtures/ws-app): echo, a guard's 401, a foreign Origin's 403, a topic across two workers,
// the max payload from `[actions.ws]`, and the drain on SIGTERM (close 1001, exit 0).
// Run alone: `bun test --timeout 300000 tests/server/ws.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { connect, refusedStatus } from './ws-harness'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/ws-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let host = ''
let log = ''

const url = (path: string) => `ws://${host}/app/api${path}`
const sameOrigin = () => ({ origin: `http://${host}` })

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}\n${b.stdout.toString()}`)
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
  host = /listening on (\S+)/.exec(out)![1]!
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; log += dec.decode(value) } })()
}, 240_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('a socket pinned to one of two workers: peers on different workers hear each other through the topic, the sender does not hear itself', async () => {
  // This runs first: with no socket open the least-loaded rule (D5) puts the first peer on one worker and the second on the other.
  const a = connect(url('/room'))
  await a.opened
  const wa = String(await a.next())
  const b = connect(url('/room'))
  await b.opened
  const wb = String(await b.next())
  expect(wa).toMatch(/^worker:\d+$/)
  expect(wb).toMatch(/^worker:\d+$/)
  expect(wa).not.toBe(wb)
  a.ws.send('hello')
  expect(await b.next()).toBe('peer:hello')
  expect(await a.quiet(300)).toBe(true)
  b.ws.send('back')
  expect(await a.next()).toBe('peer:back')
  a.ws.close(1000, 'done')
  b.ws.close(1000, 'done')
  expect((await a.closed).code).toBe(1000)
  await b.closed
})

test('echo under the base path and the actions prefix: text and binary, with and without a same-origin Origin', async () => {
  for (const headers of [{}, sameOrigin()]) {
    const c = connect(url('/echo'), headers)
    await c.opened
    c.ws.send('ping')
    expect(await c.next()).toBe('ping')
    c.ws.send(new Uint8Array([1, 2, 3, 250]))
    expect([...new Uint8Array((await c.next()) as ArrayBuffer)]).toEqual([1, 2, 3, 250])
    c.ws.close(1000, 'bye')
    expect((await c.closed).code).toBe(1000)
  }
  // an ordinary action of the same app still answers under the same prefix
  const r = await fetch(`http://${host}/app/api/hello`)
  expect(await r.json()).toEqual({ hello: 'world' })
})

test('an upgrade outside the base path or on a path no .ws() owns is refused, not accepted', async () => {
  expect(await refusedStatus(`ws://${host}/api/echo`)).toBe(404)
  expect(await refusedStatus(url('/nope'))).toBe(404)
})

test('the guard of a .ws() route refuses with its own status; with the token the socket opens', async () => {
  expect(await refusedStatus(url('/private'))).toBe(401)
  expect(await refusedStatus(url('/private'), { 'x-token': 'wrong' })).toBe(401)
  const c = connect(url('/private'), { 'x-token': 'secret' })
  await c.opened
  expect(await c.next()).toBe('welcome')
  c.ws.send('x')
  expect(await c.next()).toBe('private:x')
  c.ws.close(1000, 'bye')
  await c.closed
})

test('a foreign Origin is refused 403 before any worker runs; a missing Origin is allowed', async () => {
  expect(await refusedStatus(url('/echo'), { origin: 'https://evil.example' })).toBe(403)
  const c = connect(url('/echo'))
  await c.opened
  c.ws.close(1000, 'bye')
  await c.closed
})

test('a message over [actions.ws] max_payload_bytes closes the socket with 1009', async () => {
  const c = connect(url('/echo'))
  await c.opened
  c.ws.send('x'.repeat(8192))
  const closed = await c.closed
  expect(closed.code).toBe(1009)
})

test('SIGTERM drains: an open socket gets close 1001 and the process exits 0', async () => {
  const c = connect(url('/echo'))
  await c.opened
  c.ws.send('alive')
  expect(await c.next()).toBe('alive')
  proc.kill('SIGTERM')
  const closed = await c.closed
  expect(closed.code).toBe(1001)
  const code = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => 'timeout' as const)])
  expect(code).toBe(0)
})
