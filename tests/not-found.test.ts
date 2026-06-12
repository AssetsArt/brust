import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { createServer } from 'node:net'

// Integration coverage for the 404 catch-all feature (Tasks 3+4): an unmatched
// path renders the nearest catch-all (`path: '*'`) at HTTP 404 across BOTH
// match sites — the general render site and the SPA-nav `/_brust/page` site —
// and a control app with NO catch-all still returns the plain 404.

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as import('node:net').AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('process closed stdout before listening log')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m) {
      reader.releaseLock()
      return parseInt(m[1], 10)
    }
  }
}

async function startApp(entry: string): Promise<{ port: number; proc: Subprocess }> {
  const port = await freePort()
  const proc = spawn({
    cmd: ['bun', 'run', entry],
    env: {
      ...process.env,
      BRUST_PORT: String(port),
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout!)
  return { port: readyPort, proc }
}

// App WITH a global catch-all (`{ path: '*', Component: NotFoundPage }`).
let withCatchAll: { port: number; proc: Subprocess } | null = null
// Control app: the shared integration fixture has NO catch-all.
let noCatchAll: { port: number; proc: Subprocess } | null = null

beforeAll(async () => {
  withCatchAll = await startApp('tests/fixtures/notfound-app/index.ts')
  noCatchAll = await startApp('tests/fixtures/app/index.ts')
}, 30_000)

afterAll(async () => {
  for (const s of [withCatchAll, noCatchAll]) {
    if (!s) continue
    s.proc.kill('SIGINT')
    await s.proc.exited
  }
})

test('GET / still 200 — the real route is unaffected', async () => {
  const { port } = withCatchAll!
  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)
  expect(await resp.text()).toContain('HOME PAGE')
})

test('GET /nope renders the catch-all at HTTP 404 with its body', async () => {
  const { port } = withCatchAll!
  const resp = await fetch(`http://127.0.0.1:${port}/nope`)
  expect(resp.status).toBe(404)
  const body = await resp.text()
  expect(body).toContain('NOT FOUND PAGE')
})

test('SPA-nav GET /_brust/page/nope → 404 with a rendered body (not the bare error JSON)', async () => {
  const { port } = withCatchAll!
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/nope`)
  expect(resp.status).toBe(404)
  const body = await resp.text()
  // The nav payload is a JSON envelope `{ html, title, store }` carrying the
  // rendered <main> body — NOT the bare `{"error":"not found"}`.
  expect(body).not.toBe('{"error":"not found"}')
  const payload = JSON.parse(body) as { html?: string; title?: string }
  expect(payload.html ?? '').toContain('NOT FOUND PAGE')
})

test('SPA-nav GET /_brust/page/ for the real route still renders the page', async () => {
  const { port } = withCatchAll!
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/page/`)
  expect(resp.status).toBe(200)
  const payload = JSON.parse(await resp.text()) as { html?: string }
  expect(payload.html ?? '').toContain('HOME PAGE')
})

test('app with NO catch-all → GET /nope returns the plain 404 (unchanged)', async () => {
  const { port } = noCatchAll!
  const resp = await fetch(`http://127.0.0.1:${port}/no/such/path`)
  expect(resp.status).toBe(404)
  // No catch-all registered → the framework's last-resort error_404() body,
  // NOT a rendered page.
  expect(await resp.text()).not.toContain('NOT FOUND PAGE')
})
