// F471 served: `client({ middleware })` against a real `brust start` actions-only server, used the way a loader uses it
// (Bun, `baseUrl`, no page). A typed 401 comes back, the middleware renews the session once (single-flight) and sends
// the same request again; two Set-Cookie headers survive the Rust server on a typed answer. Run alone:
// `bun test --timeout 180000 tests/server/action-middleware.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type ActionMiddleware, client } from '../../packages/brust/src/actions/client'
import type { App } from '../../packages/brust/test/fixtures/action-middleware/actions'

const src = join(import.meta.dir, '../../packages/brust/test/fixtures/action-middleware')
const run = src
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  rmSync(join(run, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_ACTIONS_BASE_URL: '' }
  const b = Bun.spawnSync([bin, 'build', '--actions-only'], { cwd: run, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: run, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if (proc && (await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(run, 'dist'), { recursive: true, force: true })
})

/** A cookie jar + single-flight renewal + a custom header: the two recipes from docs/actions.md. */
function session() {
  const jar = new Map<string, string>()
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv!.indexOf('=')
      jar.set(kv!.slice(0, i), kv!.slice(i + 1))
    }
  }
  let renewing: Promise<boolean> | undefined
  let renewals = 0
  const renewSession = () =>
    (renewing ??= (async () => {
      renewals++
      const res = await fetch(`${base}/refresh`, { method: 'POST' })
      store(res)
      return res.ok
    })().finally(() => { renewing = undefined }))
  const withCookies = (req: Request) => {
    const r = new Request(req)
    if (jar.size) r.headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    return r
  }
  const renew: ActionMiddleware = async (req, next) => {
    const res = await next(req)
    if (res.status !== 401) return res
    return (await renewSession()) ? next(req) : res
  }
  const cookies: ActionMiddleware = async (req, next) => {
    const res = await next(withCookies(req))
    store(res)
    return res
  }
  const org: ActionMiddleware = (req, next) => {
    const r = new Request(req)
    r.headers.set('x-org', 'org-1')
    return next(r)
  }
  const api = client<App>({ baseUrl: base, prefix: '/', middleware: [renew, cookies, org] })
  return { api, jar, renewals: () => renewals }
}

test('a real server delivers BOTH Set-Cookie headers on a typed 401', async () => {
  const res = await fetch(`${base}/logout`, { method: 'POST' })
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: 'unauthorized' })
  expect(res.headers.getSetCookie().map((c) => c.split(';')[0]).sort()).toEqual(['csrf=', 'sid='])
})

test('401 → renew once → the same GET is sent again and succeeds, with the custom header', async () => {
  const s = session()
  const r = await s.api.me.get()
  expect(r.status).toBe(200)
  expect(r.data).toEqual({ user: 'ash', org: 'org-1' })
  expect(s.renewals()).toBe(1)
  expect([...s.jar.keys()].sort()).toEqual(['csrf', 'sid'])
})

test('401 on a POST: the retry carries the same JSON body', async () => {
  const s = session()
  const r = await s.api.notes.post({ text: 'hello' })
  expect(r.status).toBe(200)
  expect(r.data).toEqual({ saved: 'hello' })
  expect(s.renewals()).toBe(1)
})

test('single-flight: five parallel 401s renew the session once', async () => {
  const s = session()
  const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => s.api.notes.post({ text: `n${n}` })))
  expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
  expect(rs.map((r) => r.data?.saved)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  expect(s.renewals()).toBe(1)
})

test('with a session already, nothing renews', async () => {
  const s = session()
  await s.api.me.get()
  const r = await s.api.me.get()
  expect(r.status).toBe(200)
  expect(s.renewals()).toBe(1)
})

test('typed 401 stays typed when the renewal gives up', async () => {
  const api = client<App>({ baseUrl: base, prefix: '/', middleware: [async (req, next) => next(req)] })
  const r = await api.me.get()
  expect(r.status).toBe(401)
  if (r.error?.status === 401) expect(r.error.value.error).toBe('unauthorized')
  else throw new Error('expected a typed 401')
})
