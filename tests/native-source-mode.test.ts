import { afterAll, expect, test } from 'bun:test'
import { spawn } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// B6 Area 2: a prebuilt-free `bun run <entry>` (SOURCE mode) must self-heal its
// native templates. The runtime emits `.brust/jinja` at boot when the marker is
// missing/stale, so a `native: true` route renders WITHOUT a prior `brust build`
// — the "must build first" papercut. Boot from an ISOLATED cwd so `.brust` is
// guaranteed absent at start and never collides with the repo's own cache.

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const FIXTURE_ENTRY = path.join(REPO_ROOT, 'tests/fixtures/app/index.ts')
const port = 38301

let proc: ReturnType<typeof spawn> | undefined
let proj: string | undefined

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
  if (proj) await rm(proj, { recursive: true, force: true })
})

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server not ready at ${url}: ${String(lastErr)}`)
}

test('source mode (`bun run <entry>`) compiles native templates at boot — no prior `brust build`', async () => {
  proj = await mkdtemp(path.join(tmpdir(), 'brust-srcmode-'))
  // Sanity: the isolated cwd has NO emitted templates yet.
  expect(existsSync(path.join(proj, '.brust', 'jinja'))).toBe(false)

  proc = spawn({
    cmd: ['bun', 'run', FIXTURE_ENTRY],
    cwd: proj,
    env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  // Source-mode boot also bundles island chunks (Bun.build) — give it headroom.
  await waitForReady(`http://127.0.0.1:${port}`, 30_000)

  const res = await fetch(`http://127.0.0.1:${port}/_test/native-island-ssr`)
  expect(res.status).toBe(200)
  const html = await res.text()
  // The native template rendered (not a 404 / empty shell) AND the SSR island's
  // props came through — proves the boot-time emit produced jinja + islands.json.
  expect(html).toContain('data-brust-props="{&quot;start&quot;:5}"')
  expect(html).toContain('data-testid="counter"')

  // The emit landed in the isolated cwd's cache, exactly where the runtime reads.
  expect(existsSync(path.join(proj, '.brust', 'jinja', '_manifest.json'))).toBe(true)
}, 45_000)
