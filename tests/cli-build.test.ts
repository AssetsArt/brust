import { test, expect, afterAll } from 'bun:test'
import { spawn, $ } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')

let distDir: string
let proc: ReturnType<typeof spawn> | undefined
const port = 38291

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
})

test('brust build → run → smoke all major paths', async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'brust-dist-cli-test-'))

  // 1. Build
  const buildResult =
    await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'example/hello-world/index.ts')} --out-dir ${distDir}`.nothrow()
  expect(buildResult.exitCode).toBe(0)

  // 2. Verify dist tree
  expect(existsSync(path.join(distDir, 'index.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'mcp-manifest.json'))).toBe(true)
  expect(existsSync(path.join(distDir, '_actions-prebuilt.ts'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/_bootstrap.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/_react.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/Counter.js'))).toBe(true)

  // native binary present (filename varies by platform — Darwin: index.darwin-arm64.node,
  // Linux: index.linux-x64-gnu.node, etc. — match the pattern build.ts uses).
  const { readdir } = await import('node:fs/promises')
  const nativeFiles = await readdir(path.join(distDir, 'native'))
  expect(nativeFiles.filter((f) => /^index\..+\.node$/.test(f)).length).toBeGreaterThan(0)

  // 3. Banner injection
  const bundle = await Bun.file(path.join(distDir, 'index.js')).text()
  expect(bundle).toContain('process.env.BRUST_PREBUILT')
  expect(bundle).toContain('BRUST_DIST_DIR')

  // 4. Boot the prebuilt server
  proc = spawn({
    cmd: ['bun', 'run', path.join(distDir, 'index.js')],
    env: {
      ...process.env,
      BRUST_PORT: String(port),
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  await waitForPort(port, 10_000)

  // 5. Smoke major paths
  const ping = await fetch(`http://127.0.0.1:${port}/ping`)
  expect(ping.status).toBe(200)
  expect(await ping.text()).toBe('pong\n')

  const home = await fetch(`http://127.0.0.1:${port}/`)
  expect(home.status).toBe(200)
  expect(await home.text()).toMatch(/Hello/i)

  const counter = await fetch(`http://127.0.0.1:${port}/_brust/islands/Counter.js`)
  expect(counter.status).toBe(200)
  expect(counter.headers.get('content-type')).toContain('javascript')

  const mcp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }),
  })
  expect(mcp.status).toBe(200)
  const mcpBody = (await mcp.json()) as any
  expect(mcpBody.jsonrpc).toBe('2.0')
  expect(mcpBody.id).toBe(1)
  expect(mcpBody.result).toBeDefined()
}, 60_000)

test('brust build with missing entry exits 1 with a clear message', async () => {
  const result =
    await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build /no/such/entry.ts`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('no entry file at /no/such/entry.ts')
})

test('brust (no subcommand) exits 1', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')}`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('missing subcommand')
})

test('brust build emits dist/css/app.css with compiled Tailwind', async () => {
  expect(existsSync(`${distDir}/css/app.css`)).toBe(true)
  const css = await Bun.file(`${distDir}/css/app.css`).text()
  // Tailwind v4 preflight signature — `*,` selector prefix (with optional spaces around comma).
  expect(css).toMatch(/\*,\s*::(?:before|after|backdrop)/)
  // A utility class actually used by the migrated example app.
  expect(css).toContain('.flex')
})

test('GET /_brust/css/app.css serves with correct headers', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/app.css`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type') ?? '').toMatch(/^text\/css/)
  expect(r.headers.get('cache-control') ?? '').toMatch(/max-age=3600/)
  const text = await r.text()
  expect(text.length).toBeGreaterThan(100)
})

test('SSR HTML contains <link rel="stylesheet"> immediately before </head>', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  const linkTag = '<link rel="stylesheet" href="/_brust/css/app.css">'
  const linkIdx = html.indexOf(linkTag)
  const headEnd = html.indexOf('</head>')
  expect(linkIdx).toBeGreaterThan(-1)
  expect(headEnd).toBeGreaterThan(-1)
  expect(linkIdx).toBeLessThan(headEnd)
  // Nothing between the link tag and </head> (allowing 0 chars of slack).
  expect(headEnd - (linkIdx + linkTag.length)).toBe(0)
})

test('GET /_brust/css/..%2Fetc%2Fpasswd is 404', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/..%2Fetc%2Fpasswd`)
  expect(r.status).toBe(404)
})

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: AbortSignal.timeout(500),
      })
      if (r.ok) return
    } catch {
      // not ready yet (connection refused, abort, etc.)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`port ${port} did not start within ${timeoutMs}ms`)
}
