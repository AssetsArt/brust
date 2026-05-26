import { test, expect, afterAll } from 'bun:test'
import { spawn, $ } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')

let distDir: string
let proc: ReturnType<typeof spawn> | undefined

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
})

test('brust build emits a complete dist tree from example/hello-world', async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'brust-dist-cli-test-'))

  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'example/hello-world/index.ts')} --out-dir ${distDir}`.nothrow()
  expect(result.exitCode).toBe(0)

  expect(existsSync(path.join(distDir, 'index.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'mcp-manifest.json'))).toBe(true)
  expect(existsSync(path.join(distDir, '_actions-prebuilt.ts'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/_bootstrap.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/_react.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/Counter.js'))).toBe(true)

  const triple = `${process.platform}-${process.arch}`
  expect(existsSync(path.join(distDir, 'native', `index.${triple}.node`))).toBe(true)

  const bundle = await Bun.file(path.join(distDir, 'index.js')).text()
  expect(bundle).toContain("process.env.BRUST_PREBUILT")
  expect(bundle).toContain("BRUST_DIST_DIR")
}, 60_000)

test('bun run dist/index.js serves all major paths', async () => {
  const port = 38291
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

  // /ping — Rust-native route
  const ping = await fetch(`http://127.0.0.1:${port}/ping`)
  expect(ping.status).toBe(200)
  expect(await ping.text()).toBe('pong\n')

  // / — React SSR through the worker pool
  const home = await fetch(`http://127.0.0.1:${port}/`)
  expect(home.status).toBe(200)
  const homeBody = await home.text()
  expect(homeBody).toMatch(/Hello/i)

  // Island chunk served from dist/islands
  const counter = await fetch(`http://127.0.0.1:${port}/_brust/islands/Counter.js`)
  expect(counter.status).toBe(200)
  expect(counter.headers.get('content-type')).toContain('javascript')

  // MCP initialize roundtrip
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
  const mcpBody = await mcp.json() as any
  expect(mcpBody.jsonrpc).toBe('2.0')
  expect(mcpBody.id).toBe(1)
  expect(mcpBody.result).toBeDefined()
}, 30_000)

test('brust build with missing entry exits 1 with a clear message', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build /no/such/entry.ts`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('no entry file at /no/such/entry.ts')
})

test('brust (no subcommand) exits 1', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')}`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('missing subcommand')
})

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`)
      if (r.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`port ${port} did not start within ${timeoutMs}ms`)
}
