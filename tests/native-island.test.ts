import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'

/** Sub-project J / native islands E2E — proves the full `native: true` + CLIENT-ONLY
 * <Island> pipeline end-to-end:
 *
 *   NativeIslandPage.tsx (<Island component={Counter} props={count} />, no ssr)
 *     → jsx-rustc compile → .brust/jinja/NativeIslandPage.jinja
 *         (empty data-brust-csr mount + island_Counter_props placeholder)
 *     → T6 reconcile bakes {% raw %}…{% endraw %} importmap+bootstrap onto the .jinja
 *     → brust boot reads .brust/jinja/ into minijinja (the {% raw %} block MUST
 *        compile — if it didn't, this route would 500)
 *     → T7's native branch fills island_Counter_props with entity-encoded props JSON
 *     → served HTML = static shell + empty client-only mount + literal bootstrap
 *
 * This task proves the SERVED HTML SHAPE + that the baked template compiles at boot.
 * Browser interactivity (the createRoot hydration branch) is OUT OF SCOPE here — this
 * repo has no Playwright/puppeteer infra; that branch is unit-tested in T5. A browser
 * interactivity smoke is a documented follow-up.
 *
 * Mirrors tests/jinja-route.test.ts's boot harness (cargo build jsx-rustc → brust
 * build → spawn → waitForReady → SIGINT), on a different port (3802) to avoid clashes.
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3802'

let proc: ReturnType<typeof spawn> | undefined

async function waitForReady(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`)
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}: ${String(lastErr)}`)
}

beforeAll(async () => {
  // Pre-flight 1: build jsx-rustc binary (the build CLI invokes
  // target/{release,debug}/jsx-rustc; without it, emitNativeTemplates throws).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(`cargo build -p jsx-rust-compiler --bin jsx-rustc failed (exit ${buildRustc.exitCode})`)
  }

  // Pre-flight 2: run brust build against the fixture entry. This compiles the
  // native pages to .brust/jinja/, bakes islands per T6, and bundles the island
  // chunks (island.config.ts registers Counter).
  const buildRes = spawnSync({
    cmd: ['bun', 'run', resolve(REPO_ROOT, 'runtime/cli/index.ts'), 'build', 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (buildRes.exitCode !== 0) {
    const stdoutStr = buildRes.stdout ? new TextDecoder().decode(buildRes.stdout) : ''
    const stderrStr = buildRes.stderr ? new TextDecoder().decode(buildRes.stderr) : ''
    throw new Error(`brust build failed (exit ${buildRes.exitCode}):\n${stdoutStr}\n${stderrStr}`)
  }

  // Sanity-check the build pass: the native-island template + its islands
  // manifest must exist, and the baked .jinja must carry the {% raw %} block.
  const jinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeIslandPage.jinja')
  const islandsJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeIslandPage.islands.json')
  const manifestPath = resolve(FIXTURE_DIR, '.brust/jinja/_manifest.json')
  expect(existsSync(jinjaPath)).toBe(true)
  expect(existsSync(islandsJsonPath)).toBe(true)
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.templates).toContain('NativeIslandPage')
  expect(readFileSync(jinjaPath, 'utf8')).toContain('{% raw %}')

  // Spawn brust against the fixture (port 3802 to avoid clashing with the 3801
  // used by jinja-route.test.ts).
  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: '3802',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(BASE_URL)
}, 60_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    try {
      await proc.exited
    } catch {
      // Process may have already exited.
    }
  }
})

test('GET /_test/native-island — client-only island: static shell + empty CSR mount + bootstrap', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-island`)

  // The bake-compile proof: if the baked {% raw %}…{% endraw %} importmap block
  // had failed to compile into the minijinja Environment at boot, this route
  // would 500. A 200 here proves the template compiled.
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()

  // Static shell rendered by jinja from the loader's `greeting`.
  expect(body).toContain('<h1>Hello islands</h1>')

  // Client-only island mount: id, CSR marker, and the entity-encoded props JSON
  // of { start: 3 } (single-encoding — NOT double-escaped to &amp;quot;).
  expect(body).toContain('data-brust-island="Counter"')
  expect(body).toContain('data-brust-csr')
  expect(body).toContain('data-brust-props="{&quot;start&quot;:3}"')

  // The mount div is EMPTY — client-only means no server-rendered markup between
  // the open/close tags. The compiled mount closes immediately after the CSR
  // marker: `data-brust-csr></div>` with nothing between `>` and `</div>`.
  expect(body).toContain('data-brust-csr></div>')

  // Bootstrap baked by T6: the importmap + the module bootstrap script appear
  // LITERALLY (minijinja strips the {% raw %}/{% endraw %} markers, emitting the
  // inner text verbatim).
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')

  // The {% raw %}/{% endraw %} markers themselves must NOT leak into the output.
  expect(body).not.toContain('{% raw %}')
  expect(body).not.toContain('{% endraw %}')
})

test('GET /_test/native/Alice — no-island native route unchanged (no bootstrap)', async () => {
  // Regression: the existing no-island native path must stay byte-identical —
  // no importmap, no bootstrap script, no island markers.
  const res = await fetch(`${BASE_URL}/_test/native/Alice`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Alice</h1>')
  expect(body).not.toContain('/_brust/islands/_bootstrap.js')
  expect(body).not.toContain('<script type="importmap">')
  expect(body).not.toContain('data-brust-island')
})
