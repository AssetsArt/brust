// CORS integration — OWN FILE/PROCESS on purpose: combined fixture suites have
// a known port-race flake, and this suite needs a special boot (BRUST_TEST_CORS=1
// flips the fixture's `cors` option on; every other suite boots without it and
// stays byte-identical no-CORS). Policy under test (tests/fixtures/app/index.ts):
//   { origins: ['http://allowed.test'], credentials: true, exposeHeaders: ['x-render-ms'] }
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { createServer } from 'node:net'

const ALLOWED = 'http://allowed.test'

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

let server: { port: number; proc: Subprocess } | null = null

beforeAll(async () => {
  const port = await freePort()
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: String(port),
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=warn',
      BRUST_TEST_CORS: '1',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  server = { port: readyPort, proc }
}, 30_000) // boot includes the island chunk build; cold CI needs headroom

afterAll(async () => {
  if (!server) return
  server.proc.kill('SIGINT')
  expect(await server.proc.exited).toBe(0)
})

function port(): number {
  if (!server) throw new Error('cors server not started')
  return server.port
}

/** Case-insensitive Vary token check (Vary is a comma-joined token list). */
function varyTokens(resp: Response): string[] {
  return (resp.headers.get('vary') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

test('preflight OPTIONS on the action path → 204 with full CORS headers', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/_brust/action/notes`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  expect(resp.status).toBe(204)
  expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  expect(resp.headers.get('access-control-allow-methods')).toContain('POST')
  expect(resp.headers.get('access-control-allow-credentials')).toBe('true')
  // No `headers` configured → echo of Access-Control-Request-Headers.
  expect(resp.headers.get('access-control-allow-headers')).toBe('content-type')
  expect(resp.headers.get('access-control-max-age')).toBe('600') // framework default
  // Preflight answer varies by all three request inputs.
  expect(varyTokens(resp)).toEqual([
    'origin',
    'access-control-request-method',
    'access-control-request-headers',
  ])
})

test('actual POST action with allowed Origin → 200 + ACAO + credentials + expose + Vary', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/_brust/action/notes`, {
    method: 'POST',
    headers: { Origin: ALLOWED, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  })
  expect(resp.status).toBe(200)
  expect(await resp.json()).toEqual({ id: 'n-2' })
  expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  expect(resp.headers.get('access-control-allow-credentials')).toBe('true')
  expect(resp.headers.get('access-control-expose-headers')).toBe('x-render-ms')
  expect(varyTokens(resp)).toContain('origin')
})

test('disallowed Origin → request processed (200) but no ACAO; Vary still has Origin', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/_brust/action/notes`, {
    method: 'POST',
    headers: { Origin: 'http://evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  })
  // The server is not the enforcement point for non-preflight requests — the
  // browser blocks the READ when ACAO is missing.
  expect(resp.status).toBe(200)
  expect(resp.headers.get('access-control-allow-origin')).toBeNull()
  expect(resp.headers.get('access-control-allow-credentials')).toBeNull()
  expect(varyTokens(resp)).toContain('origin')
})

test('page GET with allowed Origin carries ACAO (global policy, pages too)', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/`, {
    headers: { Origin: ALLOWED },
  })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  expect(varyTokens(resp)).toContain('origin')
})

test('OPTIONS without preflight headers keeps the existing 405 fallback', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/_brust/action/notes`, {
    method: 'OPTIONS',
    headers: { Origin: ALLOWED }, // no Access-Control-Request-Method → not a preflight
  })
  expect(resp.status).toBe(405)
})

test('static asset Vary merges Accept-Encoding AND Origin (append, not replace)', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/_brust/css/app.css`, {
    headers: { Origin: ALLOWED },
  })
  expect(resp.status).toBe(200)
  // static_asset_response emits Vary: Accept-Encoding for compressible types;
  // the CORS chokepoint must APPEND Origin (an insert would drop the encoding
  // variance — CDN cache poisoning either way).
  const tokens = varyTokens(resp)
  expect(tokens).toContain('accept-encoding')
  expect(tokens).toContain('origin')
  expect(resp.headers.get('access-control-allow-origin')).toBe(ALLOWED)
})
