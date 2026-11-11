// F529 D12: `brust dev` relays a WebSocket upgrade under the actions prefix to the child (packages/brust/test/fixtures/ws-app,
// base path /app): echo through the proxy, the child's guard 401 and Origin 403 reach the client, an upgrade of the dev
// channel's own socket is not taken for an action socket.
// Run alone: `bun test --timeout 300000 tests/server/ws-dev.test.ts`.
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
  host = `localhost:${port}`
  proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  const dec = new TextDecoder()
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[])
    void (async () => { for await (const c of s) log += dec.decode(c, { stream: true }) })()
  for (let i = 0; i < 1200 && !/\[brust\] ready/.test(log); i++) await Bun.sleep(100)
  if (!/\[brust\] ready/.test(log)) throw new Error(`brust dev not ready:\n${log}`)
}, 240_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if (proc && (await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
})

test('echo through the dev proxy, under the base path and the actions prefix, with a same-origin Origin', async () => {
  const c = connect(url('/echo'), { origin: `http://${host}` })
  await c.opened
  c.ws.send('ping')
  expect(await c.next()).toBe('ping')
  c.ws.send(new Uint8Array([9, 8, 7]))
  expect([...new Uint8Array((await c.next()) as ArrayBuffer)]).toEqual([9, 8, 7])
  c.ws.close(1000, 'bye')
  expect((await c.closed).code).toBe(1000)
})

test('the child\'s guard 401 and the proxy\'s Origin 403 reach the client as HTTP statuses', async () => {
  expect(await refusedStatus(url('/private'))).toBe(401)
  const c = connect(url('/private'), { 'x-token': 'secret' })
  await c.opened
  expect(await c.next()).toBe('welcome')
  c.ws.close(1000, 'bye')
  await c.closed
  expect(await refusedStatus(url('/echo'), { origin: 'https://evil.example' })).toBe(403)
})

test('a topic works through the relay too', async () => {
  const a = connect(url('/room'))
  const b = connect(url('/room'))
  await Promise.all([a.opened, b.opened])
  await a.next()
  await b.next()
  a.ws.send('hi')
  expect(await b.next()).toBe('peer:hi')
  a.ws.close(1000, 'bye')
  b.ws.close(1000, 'bye')
  await Promise.all([a.closed, b.closed])
})
