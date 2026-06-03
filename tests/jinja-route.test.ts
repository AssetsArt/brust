import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'

/** Sub-project J E2E — verifies the full native: true pipeline end-to-end:
 *
 *   .tsx page (NativeProfile)
 *     → jsx-rustc compile → .brust/jinja/NativeProfile.jinja
 *     → brust boot reads .brust/jinja/ into minijinja Environment
 *     → request matched by route table with nativeTemplate field
 *     → worker dispatcher runs loader, writes JSON into SAB
 *     → napi_render_jinja renders + assembles [meta_len][meta][body]
 *     → split_meta + chunk shipped to client
 *
 * The test spawns brust against tests/fixtures/app (shape mirrors
 * tests/integration.test.ts) and curls the route.
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3801'

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

  // Pre-flight 2: run brust build against the fixture entry. This emits
  // .brust/jinja/NativeProfile.jinja into the fixture dir so the brust
  // boot path can load it into the minijinja Environment.
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

  // Sanity-check the build pass.
  const jinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeProfile.jinja')
  const manifestPath = resolve(FIXTURE_DIR, '.brust/jinja/_manifest.json')
  expect(existsSync(jinjaPath)).toBe(true)
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.templates).toContain('NativeProfile')

  // Spawn brust against the fixture. Match the env shape used by
  // tests/integration.test.ts so worker spawning behaves identically.
  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: '3801',
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

test('GET /_test/native/Alice — minijinja-rendered HTML with loader data', async () => {
  const res = await fetch(`${BASE_URL}/_test/native/Alice`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Alice</h1>')
  expect(body).toContain('<p>User: Alice</p>')
})

test('GET /_test/native/Bob — different param renders correctly', async () => {
  const res = await fetch(`${BASE_URL}/_test/native/Bob`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Bob</h1>')
  expect(body).toContain('<p>User: Bob</p>')
})

test('GET /this-does-not-exist — 404 (regression — React path unaffected)', async () => {
  const res = await fetch(`${BASE_URL}/this-does-not-exist`)
  expect(res.status).toBe(404)
})

test('GET / — HelloWorld React route still works', async () => {
  const res = await fetch(`${BASE_URL}/`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body.length).toBeGreaterThan(0)
})

test('GET /_test/nested-map — nested .map() renders nested HTML', async () => {
  const res = await fetch(`${BASE_URL}/_test/nested-map`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const body = await res.text()
  // Outer map → 2 rows; inner map → 3 cells total (2 + 1), in order.
  expect((body.match(/class="row"/g) ?? []).length).toBe(2)
  expect(body).toContain('<span class="cell">a</span>')
  expect(body).toContain('<span class="cell">b</span>')
  expect(body).toContain('<span class="cell">c</span>')
  // 'a' before 'b' before 'c'.
  expect(body.indexOf('>a<')).toBeLessThan(body.indexOf('>b<'))
  expect(body.indexOf('>b<')).toBeLessThan(body.indexOf('>c<'))
})

test('GET /_test/data-attr — BrustPage data-* lands on <html>', async () => {
  const res = await fetch(`${BASE_URL}/_test/data-attr`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<html lang="en" data-mode="dark" data-rev="r42">')
})

// T4 — native <Outlet> nested route E2E. A native PARENT layout
// (NativeOutletLayout: BrustPage shell + <nav> + <main><Outlet/></main>)
// wrapping a native LEAF fragment (NativeOutletLeaf), each with its own loader.
// The build composes the chain into ONE native template (synth wrapper fills
// <Outlet/> with the leaf body); runNativeChainLoaders merges both loaders
// top-down. This proves T1 (<Outlet/> lowering) + T2 (chain compose) + T3
// (loader merge) end-to-end through the minijinja render pipeline.
test('GET /_test/outlet — nested native chain composes layout + leaf with merged loaders', async () => {
  const res = await fetch(`${BASE_URL}/_test/outlet`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const body = await res.text()

  // Shell: BrustPage owns <html> + framework <head>; layout chrome <nav> present.
  expect(body).toContain('<html')
  expect(body).toContain('<nav class="chrome">')

  // Exactly ONE <main> and ONE <title> — no duplicate shell from the leaf, no
  // surviving wrapper artifacts.
  expect((body.match(/<main[\s>]/g) ?? []).length).toBe(1)
  expect((body.match(/<title[\s>]/g) ?? []).length).toBe(1)

  // The <Outlet/> tag must NOT survive into the rendered HTML — it is replaced
  // by the leaf body at build time.
  expect(body).not.toContain('<Outlet')
  expect(body.toLowerCase()).not.toContain('outlet />')

  // The leaf content lives INSIDE <main> (composed at the <Outlet/> slot).
  const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  expect(mainMatch).not.toBeNull()
  const mainInner = mainMatch![1]
  expect(mainInner).toContain('<article class="leaf">')
  expect(mainInner).toContain('widget: leaf-thing')

  // Ordering: <main> ... leaf-content ... </main>, leaf rendered after <main>.
  const mainOpen = body.search(/<main[\s>]/)
  const leafIdx = body.indexOf('<article class="leaf">')
  const mainClose = body.indexOf('</main>')
  expect(mainOpen).toBeGreaterThanOrEqual(0)
  expect(mainOpen).toBeLessThan(leafIdx)
  expect(leafIdx).toBeLessThan(mainClose)

  // BOTH loaders' data rendered → proves the top-down chain merge (T3):
  //   parent loader → `section` (in <nav>) and `title` (in <title>),
  //   leaf loader   → `widget` (in <article>).
  expect(body).toContain('section: parent-zone') // parent-chain loader field
  expect(body).toContain('widget: leaf-thing') // leaf loader field
  expect(body).toContain('<title>Outlet Page</title>') // parent loader → BrustPage title
})

// T4 — SPA-nav path. /_brust/page/{path} returns { html, title } where html is
// the <main> inner content. Exercises renderNativeRouteToHtml's chain-loader
// merge (the SPA path was previously leaf-only). Confirms the composed leaf
// body + merged loader data flow through the navigation branch too.
test('GET /_brust/page/_test/outlet — SPA-nav envelope carries composed leaf + merged title', async () => {
  const res = await fetch(`${BASE_URL}/_brust/page/_test/outlet`)
  expect(res.status).toBe(200)
  const payload = (await res.json()) as { html: string; title: string }

  // <main> inner content (extracted server-side) holds the composed leaf body.
  expect(payload.html).toContain('<article class="leaf">')
  expect(payload.html).toContain('widget: leaf-thing')
  // The shell <nav> lives OUTSIDE <main>, so it must NOT appear in the inner html.
  expect(payload.html).not.toContain('<nav class="chrome">')

  // Title comes from the PARENT loader (proves the merge reached the SPA path).
  expect(payload.title).toBe('Outlet Page')
})
