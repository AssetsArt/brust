import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'

/** Sub-project J / native SSR islands E2E (T10) — proves the full `native: true`
 * + SERVER-RENDERED <Island ... ssr> pipeline end-to-end, at the running-server
 * level:
 *
 *   NativeSsrIslandPage.tsx (<Island component={Counter} props={count} ssr />)
 *     → jsx-rustc compile → .brust/jinja/NativeSsrIslandPage.jinja
 *         (mount with NO data-brust-csr + `{{ island_Counter_html | safe }}`
 *          placeholder INSIDE the mount div + island_Counter_props placeholder)
 *     → T6 reconcile bakes {% raw %}…{% endraw %} importmap+bootstrap
 *     → manifest entry carries ssr:true + the absolute sourcePath of Counter.tsx
 *     → at request time, T9's resolveIslandContext imports Counter's SOURCE .tsx
 *        by absolute path and renderToStrings it server-side, filling
 *        island_Counter_html with the INITIAL markup (initial useState = start)
 *     → served HTML = static shell + mount whose innerHTML is Counter's SSR
 *        markup + literal bootstrap
 *
 * This is the real-server gating-Q1 proof: a 200 here means the WORKER (not just
 * a unit test) successfully import()ed Counter.tsx source and renderToString'd a
 * real component. A 500 would mean ssr module resolution doesn't work in the
 * running server — see ESCALATE in the task.
 *
 * Browser hydration smoke (real hydrateRoot no-mismatch verification) is OUT OF
 * SCOPE here — this repo has no Playwright/puppeteer infra; that is a documented
 * follow-up. The byte-identity of _html vs the roundtripped _props is unit-tested
 * in runtime/islands/native-render.test.ts.
 *
 * Mirrors tests/native-island.test.ts's boot harness (cargo build jsx-rustc →
 * brust build → spawn → waitForReady → SIGINT), on a different port (3803) to
 * avoid clashing with 3802 (T8) / 3801 (jinja-route).
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3803'

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
    throw new Error(
      `cargo build -p jsx-rust-compiler --bin jsx-rustc failed (exit ${buildRustc.exitCode})`,
    )
  }

  // Pre-flight 2: run brust build against the fixture entry. This compiles the
  // native pages to .brust/jinja/, bakes islands per T6, and bundles the island
  // chunks (the page's <Island component={Counter}> usage registers Counter).
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

  // Sanity-check the build pass: the native-ssr-island template + its islands
  // manifest must exist, the manifest entry must be ssr:true, and the baked
  // .jinja must carry both the {% raw %} block AND the _html placeholder.
  const jinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrIslandPage.jinja')
  const islandsJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrIslandPage.islands.json')
  const manifestPath = resolve(FIXTURE_DIR, '.brust/jinja/_manifest.json')
  expect(existsSync(jinjaPath)).toBe(true)
  expect(existsSync(islandsJsonPath)).toBe(true)
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.templates).toContain('NativeSsrIslandPage')
  const islandsManifest = JSON.parse(readFileSync(islandsJsonPath, 'utf8'))
  expect(islandsManifest.some((e: any) => e.id === 'Counter' && e.ssr === true)).toBe(true)
  const jinjaSrc = readFileSync(jinjaPath, 'utf8')
  expect(jinjaSrc).toContain('{% raw %}')
  expect(jinjaSrc).toContain('island_Counter_html')

  // Spawn brust against the fixture (port 3803 to avoid clashing with 3802/3801).
  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: '3803',
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

test('GET /_test/native-island-ssr — SSR island: static shell + server-rendered mount + bootstrap', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-island-ssr`)

  // gating-Q1 real-server proof: a 200 means the worker import()ed Counter.tsx
  // source and renderToString'd it successfully. A 500 here is the ESCALATE case
  // (ssr module resolution broken in the running server).
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()

  // Static shell rendered by jinja from the loader's `greeting`.
  expect(body).toContain('<h1>SSR islands</h1>')

  // The island mount: id + the entity-encoded props JSON of { start: 5 }.
  expect(body).toContain('data-brust-island="Counter"')
  expect(body).toContain('data-brust-props="{&quot;start&quot;:5}"')

  // SSR (not client-only): the mount must NOT carry the data-brust-csr marker.
  expect(body).not.toContain('data-brust-csr')

  // The {{ island_Counter_html | safe }} placeholder must have been RENDERED —
  // neither the placeholder nor the {% raw %}/{% endraw %} markers may leak.
  expect(body).not.toContain('island_Counter_html')
  expect(body).not.toContain('{{')
  expect(body).not.toContain('{% raw %}')
  expect(body).not.toContain('{% endraw %}')

  // SSR MARKUP IS INSIDE THE MOUNT: extract the Counter mount div's innerHTML
  // and assert Counter's initial server render is there (NOT empty).
  // renderToString(Counter, {start:5}) === a <button data-testid="counter" ...>
  // whose text is "count: 5" (React inserts <!-- --> separators between the
  // dynamic text segments).
  const open = body.indexOf('<div data-brust-island="Counter"')
  expect(open).toBeGreaterThanOrEqual(0)
  const tagEnd = body.indexOf('>', open)
  const close = body.indexOf('</div>', tagEnd)
  expect(close).toBeGreaterThan(tagEnd)
  const innerHtml = body.slice(tagEnd + 1, close)

  // The mount is NOT empty — it has Counter's server-rendered markup.
  expect(innerHtml.length).toBeGreaterThan(0)
  // Representative substrings of Counter's initial render, INSIDE the mount.
  expect(innerHtml).toContain('<button')
  expect(innerHtml).toContain('data-testid="counter"')
  // The initial useState(start=5) value is rendered server-side.
  expect(innerHtml).toContain('count')
  expect(innerHtml).toContain('5')

  // Bootstrap baked by T6 appears literally (importmap + module bootstrap).
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')
})
