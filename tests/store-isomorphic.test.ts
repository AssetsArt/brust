import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type Subprocess, spawn } from 'bun'
import { createServer } from 'node:net'

// Spec A / isomorphic store — end-to-end (T8).
//
// Proves a React-path route whose loader seeds the per-request `counter` store
// ships the seeded state in the INITIAL HTML two ways:
//   1. a <script type="application/json" data-brust-store="counter"> blob
//      injected before </head> (the buffering inject path), and
//   2. the value rendered server-side inside <main> by useStore(counter)
//      (no second client fetch needed).
// And it proves S6: two requests with different ?seed= values get isolated
// store instances — the second request never sees the first's value.
//
// Own server (not the shared one in integration.test.ts) because each request
// carries a distinct query param and we assert on the per-request store state.

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
    env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  server = { port: readyPort, proc }
}, 30_000)

afterAll(async () => {
  if (!server) return
  server.proc.kill('SIGINT')
  await server.proc.exited
})

function port(): number {
  if (!server) throw new Error('server not started')
  return server.port
}

// Pull the data-brust-store="counter" payload out of the HTML and JSON.parse it.
// The serializer escapes `<`/`>`/`&` as \uXXXX inside the script text, which is
// valid JSON, so JSON.parse over the raw text node content round-trips.
function parseStorePayload(html: string, name: string): Record<string, unknown> {
  const re = new RegExp(
    `<script type="application/json" data-brust-store="${name}">([\\s\\S]*?)</script>`,
  )
  const m = html.match(re)
  if (!m) throw new Error(`no data-brust-store="${name}" script in HTML`)
  return JSON.parse(m[1]) as Record<string, unknown>
}

test('React-path loader seeds store → data-brust-store script + rendered body (seed=7)', async () => {
  const resp = await fetch(`http://127.0.0.1:${port()}/store-demo?seed=7`)
  expect(resp.status).toBe(200)
  const html = await resp.text()

  // (1) The seeded state ships as a store script before </head>.
  expect(html).toContain('data-brust-store="counter"')
  expect(html.indexOf('data-brust-store="counter"')).toBeLessThan(html.indexOf('</head>'))
  const payload = parseStorePayload(html, 'counter')
  expect(payload.value).toBe(7)

  // (2) The value is also rendered server-side into the body — no second fetch.
  expect(html).toContain('data-testid="counter-value"')
  // React 18 may insert <!-- --> between adjacent text nodes; strip before match.
  const body = html.replace(/<!--\s*-->/g, '')
  expect(body).toMatch(/counter value:\s*<span data-testid="counter-value">7<\/span>/)
}, 15_000)

test('S6: a second request with a different seed gets isolated state (no leak)', async () => {
  // First request seeds 7 (above / again here to be order-independent).
  const first = await fetch(`http://127.0.0.1:${port()}/store-demo?seed=7`)
  expect(first.status).toBe(200)
  expect(parseStorePayload(await first.text(), 'counter').value).toBe(7)

  // Second request with a different seed must NOT see the first's value.
  const second = await fetch(`http://127.0.0.1:${port()}/store-demo?seed=42`)
  expect(second.status).toBe(200)
  const secondHtml = await second.text()
  const payload = parseStorePayload(secondHtml, 'counter')
  expect(payload.value).toBe(42)
  expect(payload.value).not.toBe(7) // S6: no cross-request leak

  const body = secondHtml.replace(/<!--\s*-->/g, '')
  expect(body).toMatch(/counter value:\s*<span data-testid="counter-value">42<\/span>/)
}, 15_000)
