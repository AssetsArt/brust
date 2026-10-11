// Builds the actions fixture with the real CLI, starts it with two Bun workers and asserts the actions
// subtree from the outside, through Rust and the bridge's `fetch` call kind (M3-F E1/E5). Run on its own:
// `bun test --timeout 120000 test/e2e-actions.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client } from '../src/actions/client'
import { setNative } from '../src/native'
import { startWorker } from '../src/worker'
import type { App } from './fixtures/actions-app/actions'

const app = join(import.meta.dir, 'fixtures/actions-app')
const bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let stdout = ''

type Stats = { worker_calls: number }
const stats = async (): Promise<Stats> => (await fetch(`${base}/_brust/cache/stats`)).json() as Promise<Stats>
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  // `bun test` sets NODE_ENV=test and run.ts keeps an explicit value; pin what a deployed `brust start` has.
  const env = { ...process.env, NODE_ENV: 'production', BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  while (!/\[brust\] ready/.test(stdout)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${stdout}`)
    stdout += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(stdout)![1]}`
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      stdout += dec.decode(value, { stream: true })
    }
  })()
}, 120_000)

afterAll(async () => {
  try {
    if (proc) {
      proc.kill('SIGINT')
      const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])
      if (exited === undefined) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    }
  } finally {
    rmSync(join(app, 'dist'), { recursive: true, force: true })
  }
})

test('1. GET /api/hello?name=ash answers through Rust', async () => {
  const res = await fetch(`${base}/api/hello?name=ash`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ hi: 'ash' })
})

test('2. two Set-Cookie headers survive as two', async () => {
  const res = await fetch(`${base}/api/cookies`)
  expect(res.status).toBe(200)
  expect(res.headers.getSetCookie().length).toBe(2)
  const t = await fetch(`${base}/api/team`, json({ id: 'a', name: 'Ash' }))
  expect(t.status).toBe(200)
  expect(t.headers.getSetCookie().some((c) => c.startsWith('sid=abc'))).toBe(true)
})

test('3. an invalid body is 422 problem+json, production shape (no errors member)', async () => {
  const res = await fetch(`${base}/api/team`, json({ id: 1 }))
  expect(res.status).toBe(422)
  expect(res.headers.get('content-type')).toContain('application/problem+json')
  const body = (await res.json()) as Record<string, unknown>
  expect(body.type).toBe('validation')
  expect(body.errors).toBeUndefined()
})

test('4. returned problem() and thrown HTTPError are both 409', async () => {
  const a = await fetch(`${base}/api/team`, json({ id: 'full', name: 'x' }))
  expect(a.status).toBe(409)
  expect(((await a.json()) as { title: string }).title).toBe('Team full')
  const b = await fetch(`${base}/api/thrown`)
  expect(b.status).toBe(409)
  expect(((await b.json()) as { type: string }).type).toBe('TEAM_FULL')
})

test("5. an unknown path under the prefix is Elysia's 404 problem, not the page 404", async () => {
  const res = await fetch(`${base}/api/nope`)
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toContain('application/problem+json')
  expect(((await res.json()) as { type: string }).type).toBe('not-found')
})

test('6. a body over max_body_bytes is 413 before the worker', async () => {
  const before = await stats()
  const res = await fetch(`${base}/api/team`, json({ id: 'a', name: 'x'.repeat(2048) }))
  expect(res.status).toBe(413)
  const after = await stats()
  expect(after.worker_calls).toBe(before.worker_calls)
})

test('7. a response over the slot is a 500 naming the limit (F82)', async () => {
  const res = await fetch(`${base}/api/big`)
  expect(res.status).toBe(500)
  expect(await res.text()).toContain('brust: action response exceeds')
})

test('8. CORS: preflight 204 with allow-origin + credentials; actual response carries them and expose-headers', async () => {
  const pre = await fetch(`${base}/api/team`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  expect(pre.status).toBe(204)
  expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example')
  expect(pre.headers.get('access-control-allow-credentials')).toBe('true')
  const res = await fetch(`${base}/api/hello`, { headers: { origin: 'https://app.example' } })
  expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example')
  expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('x-total')
})

test('9. the page carries the prefix script', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).toContain('<script>globalThis.__BRUST_ACTION_PREFIX__="/api"</script>')
})

test('10. client<App> round trip with real fetch: typed data and typed 409', async () => {
  const api = client<App>({ baseUrl: base, prefix: '/api' })
  const ok = await api.hello.get({ query: { name: 'ash' } })
  expect(ok.status).toBe(200)
  expect(ok.data).toEqual({ hi: 'ash' })
  const full = await api.team.post({ id: 'full', name: 'x' })
  expect(full.status).toBe(409)
  expect((full.error?.value as { title?: string } | undefined)?.title).toBe('Team full')
})

test('11. POST / outside the prefix is still 405', async () => {
  const res = await fetch(`${base}/`, { method: 'POST' })
  expect(res.status).toBe(405)
})

test('12. startWorker fails boot with the mountActions message when the entry has no default export', async () => {
  const d = mkdtempSync(join(tmpdir(), 'brust-actions-boot-'))
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ components: {}, actions: { entry: 'actions.js', prefix: '/api', maxBodyBytes: 1024 } }))
  writeFileSync(join(d, 'jobs.js'), 'export default {}\n')
  writeFileSync(join(d, 'routes.js'), 'export const routes = []\n')
  writeFileSync(join(d, 'actions.js'), 'export const nothing = 1\n')
  const keys = ['BRUST_DIST_DIR', 'BRUST_APP_ENTRY'] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  // biome-ignore lint/suspicious/noExplicitAny: only registerWorker is reached (and must not be)
  const prev = setNative({ registerWorker: () => 0 } as any)
  try {
    Object.assign(process.env, { BRUST_DIST_DIR: d, BRUST_APP_ENTRY: join(d, 'routes.js') })
    await expect(startWorker()).rejects.toThrow(/no default export/)
  } finally {
    setNative(prev)
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
    rmSync(d, { recursive: true, force: true })
  }
})
