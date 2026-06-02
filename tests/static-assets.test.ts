import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

// Static public-asset serving. Mirrors the integration.test.ts harness: a
// throwaway temp-dir fixture is booted with `bun run <dir>/index.ts` and we
// scrape the `listening on 127.0.0.1:<port>` line from stdout, then fetch over
// HTTP and SIGINT the process in afterAll. The fixture is a PLAIN React route
// (no <Island>, no `native: true`) so it needs NO `brust build` step — the
// dev/source runtime reads <scanRoot>/public directly.
//
// The fixture boots WITHOUT `dev: true` and WITHOUT BRUST_DEV=1, so Rust's
// is_dev_mode() is false → static assets carry `Cache-Control: public,
// max-age=3600` (the prod value). See crates/brust/src/server.rs
// asset_cache_control(): dev → "no-store", prod → "public, max-age=3600".

const REPO_ROOT = join(import.meta.dir, '..')

// 1x1 transparent PNG (70 bytes) — known-good fixture for the nested-asset +
// image/png content-type assertions.
const DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<circle cx="16" cy="16" r="15" fill="#ef4444"/>' +
  '<rect x="1" y="14" width="30" height="4" fill="#111"/>' +
  '<circle cx="16" cy="16" r="5" fill="#fff" stroke="#111" stroke-width="2"/></svg>'

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

let dir = ''
let proc: Subprocess | null = null
let port = 0

beforeAll(async () => {
  // Create the throwaway fixture UNDER tests/fixtures/ (not os tmpdir) so the
  // repo-root node_modules (react/jsx-dev-runtime) resolves for the JSX route.
  dir = await mkdtemp(join(REPO_ROOT, 'tests', 'fixtures', 'static-tmp-'))

  // Minimal plain-React route — no Island, no native — so the boot needs no
  // compile step. brust.run() derives scanRoot from dirname(entry), so the
  // public/ dir below is read as <scanRoot>/public.
  await writeFile(
    join(dir, 'routes.tsx'),
    [
      `import { defineRoutes } from '${join(REPO_ROOT, 'runtime/routes.ts')}'`,
      ``,
      `function Home() {`,
      `  return <html><body><h1>static-fixture-home</h1></body></html>`,
      `}`,
      ``,
      `export const routes = defineRoutes([{ path: '/', Component: Home }])`,
      ``,
    ].join('\n'),
  )

  await writeFile(
    join(dir, 'index.ts'),
    [
      `import { brust } from '${join(REPO_ROOT, 'runtime/index.ts')}'`,
      `import { routes } from './routes'`,
      ``,
      `await brust.run({ routes, entry: import.meta.url })`,
      ``,
    ].join('\n'),
  )

  // Static assets: <scanRoot>/public is root-mapped (favicon.svg → /favicon.svg,
  // img/dot.png → /img/dot.png).
  await mkdir(join(dir, 'public', 'img'), { recursive: true })
  await writeFile(join(dir, 'public', 'favicon.svg'), FAVICON_SVG)
  await writeFile(join(dir, 'public', 'img', 'dot.png'), DOT_PNG)

  const p = await freePort()
  proc = spawn({
    cmd: ['bun', 'run', join(dir, 'index.ts')],
    env: { ...process.env, BRUST_PORT: String(p), BRUST_WORKERS: '1', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  port = await readPortLine(proc.stdout)
}, 30_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('GET /favicon.svg → 200, image/svg+xml, exact bytes', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/favicon.svg`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
  const body = Buffer.from(await r.arrayBuffer())
  expect(body.equals(Buffer.from(FAVICON_SVG))).toBe(true)
})

test('nested GET /img/dot.png → 200, image/png', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/img/dot.png`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('image/png')
  const body = Buffer.from(await r.arrayBuffer())
  expect(body.equals(DOT_PNG)).toBe(true)
})

test('GET /definitely-missing-xyz.png → not 200 (falls through to routing → 404)', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/definitely-missing-xyz.png`)
  expect(r.status).not.toBe(200)
  expect(r.status).toBe(404)
})

test('app route / still returns 200 HTML (static does not break routing)', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('text/html')
  expect(await r.text()).toContain('static-fixture-home')
})

test('static asset carries the prod Cache-Control', async () => {
  // Fixture boots WITHOUT dev mode (no `dev: true`, no BRUST_DEV=1), so
  // is_dev_mode() is false → prod cache header.
  const r = await fetch(`http://127.0.0.1:${port}/favicon.svg`)
  expect(r.headers.get('cache-control')).toBe('public, max-age=3600')
})
