// Task 2.10 — markdown-pages integration. Proves the full md pipeline on the
// shared fixture (tests/fixtures/app), which mounts `content/docs/*.md` via
// `mdRoutes('content/docs', { prefix: '/docs', layout: MdDocsLayout,
// components: { Counter, BehaviorBadge } })`:
//
//   1. Source-mode boot serves /docs, /docs/intro, /docs/query/where with GFM
//      rendering and frontmatter-driven <title> (layout chained mode — the
//      leaf loader's `__md` feeds the layout's BrustPage props).
//   2. /docs/intro hosts: SSR island (content-addressed id, entity-encoded
//      literal props, server-rendered inner HTML), CSR island (empty mount +
//      data-brust-csr), behavior component (x-data host), the bootstrap baked
//      EXACTLY once, and a code fence whose `{{`/`{%` text renders literally
//      (brace neutralization + anchored marker renumbering).
//   3. A prebuilt dist boots and serves the same pages WITHOUT the content dir
//      on disk (routes frozen in dist/md-manifest.json).
//   4. SSG: the dist exports /docs/* statically; a dumb file server serves the
//      pages and every island chunk URL resolves.
//
// Boot harness mirrors tests/native-island.test.ts (NO playwright). Ports
// 3821/3822 — unique across the suite. Browser hydration is verified manually
// by the orchestrator (acceptance criterion 2), not here.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, renameSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'
import { createHash } from 'node:crypto'
import { collectStaticPaths, exportStatic, type FlatRouteLike } from '../runtime/cli/ssg.ts'
import { directiveName } from '../runtime/native/build.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3821'

// islandChunkBasename hashes the source path RELATIVE TO THE BUILD CWD
// (process.cwd() at build time = FIXTURE_DIR), so the expected id is computed
// against that root, not this test process's cwd.
const COUNTER_ID = `Counter_${createHash('sha256')
  .update('components/Counter.tsx')
  .digest('hex')
  .slice(0, 8)}`
const BADGE_DIRECTIVE = directiveName(
  resolve(FIXTURE_DIR, 'components/BehaviorBadge.tsx'),
  FIXTURE_DIR,
)

let proc: ReturnType<typeof spawn> | undefined

async function waitForReady(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(500) })
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}: ${String(lastErr)}`)
}

async function getOk(base: string, urlPath: string): Promise<string> {
  const res = await fetch(`${base}${urlPath}`)
  expect(`${urlPath} → ${res.status}`).toBe(`${urlPath} → 200`)
  return res.text()
}

/** The full host `<div data-brust-island=…>…</div>` for instance `n` (markers
 * are emitted in document order, so instance 0 is the first host). */
function islandHost(html: string, n: number): string {
  const hosts = [...html.matchAll(/<div data-brust-island="[^"]*"[^>]*>/g)]
  const open = hosts[n]
  expect(open).toBeDefined()
  const start = (open as RegExpMatchArray).index as number
  const end = html.indexOf('</div>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end + '</div>'.length)
}

beforeAll(async () => {
  // Pre-flight 1: the jsx-rustc binary (emitNativeTemplates shells out to it).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(`cargo build jsx-rustc failed (exit ${buildRustc.exitCode})`)
  }

  // Pre-flight 2: brust build from the fixture dir (the md content dir is
  // cwd-relative — see the gate comment in tests/fixtures/app/routes.tsx).
  const buildRes = spawnSync({
    cmd: ['bun', 'run', resolve(REPO_ROOT, 'runtime/cli/index.ts'), 'build', 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (buildRes.exitCode !== 0) {
    const out = buildRes.stdout ? new TextDecoder().decode(buildRes.stdout) : ''
    const err = buildRes.stderr ? new TextDecoder().decode(buildRes.stderr) : ''
    throw new Error(`brust build failed (exit ${buildRes.exitCode}):\n${out}\n${err}`)
  }

  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: { ...process.env, BRUST_PORT: '3821', RUST_LOG: 'brust=warn' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(BASE_URL)
}, 120_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    try {
      await proc.exited
    } catch {
      // already exited
    }
  }
})

// ── 1. Pages render: GFM + frontmatter <title> ──────────────────────────────

test('GET /docs — 200, GFM table + strikethrough, frontmatter <title>, layout chrome', async () => {
  const html = await getOk(BASE_URL, '/docs')
  expect(html).toContain('<title>Docs Home</title>')
  expect(html).toContain('<meta name="description" content="Markdown fixture index"')
  // GFM: table + strikethrough actually rendered, not passed through as text.
  expect(html).toContain('<table>')
  expect(html).toContain('<del>old</del>')
  // Heading got a slug id (custom renderer).
  expect(html).toContain('<h1 id="docs-home">Docs Home</h1>')
  // Chained mode: the layout owns the chrome + the single <main>.
  expect(html).toContain('docs fixture')
  expect(html.match(/<main>/g)?.length).toBe(1)
})

test('GET /docs/query/where — nested dir maps to nested URL', async () => {
  const html = await getOk(BASE_URL, '/docs/query/where')
  expect(html).toContain('<title>Query Where</title>')
  expect(html).toContain('query/where.md')
})

// ── 2. /docs/intro — islands, behavior, bootstrap, brace-bearing fence ──────

test('GET /docs/intro — SSR island host: content-addressed id, encoded literal props, inner HTML', async () => {
  const html = await getOk(BASE_URL, '/docs/intro')
  expect(html).toContain('<title>Intro</title>')

  const ssr = islandHost(html, 0)
  expect(ssr).toContain(`data-brust-island="${COUNTER_ID}"`)
  // propsLiteral, entity-encoded by the native render.
  expect(ssr).toContain('&quot;start&quot;:5')
  expect(ssr).toContain('&quot;label&quot;:&quot;docs&quot;')
  expect(ssr).toContain('data-brust-hydrate="load"')
  expect(ssr).not.toContain('data-brust-csr')
  // Genuinely server-rendered inner HTML (Counter's button).
  expect(ssr).toContain('data-testid="counter"')
})

test('GET /docs/intro — CSR island host: data-brust-csr + EMPTY mount', async () => {
  const html = await getOk(BASE_URL, '/docs/intro')
  const csr = islandHost(html, 1)
  expect(csr).toContain(`data-brust-island="${COUNTER_ID}"`)
  expect(csr).toContain('&quot;start&quot;:2')
  expect(csr).toContain('data-brust-csr')
  // Empty inner: the open tag is immediately followed by </div>.
  expect(csr).toMatch(/data-brust-csr><\/div>$/)
})

test('GET /docs/intro — behavior host carries the directive x-data', async () => {
  const html = await getOk(BASE_URL, '/docs/intro')
  expect(html).toContain(`<div x-data="${BADGE_DIRECTIVE}"></div>`)
  // The directive runtime is wired for it.
  expect(html).toContain('/_brust/islands/_directives.js')
})

test('GET /docs/intro — bootstrap script tag EXACTLY once', async () => {
  const html = await getOk(BASE_URL, '/docs/intro')
  const tags = html.match(/<script type="module" src="\/_brust\/islands\/_bootstrap\.js"/g) ?? []
  expect(tags.length).toBe(1)
})

test('GET /docs/intro — code fence renders brace-bearing text LITERALLY', async () => {
  const html = await getOk(BASE_URL, '/docs/intro')
  // Neutralized fence content round-trips to the exact authored text…
  expect(html).toContain('{{ island_0_props }}')
  expect(html).toContain('{% endraw %}')
  expect(html).toContain('{{ not_a_real_marker }}')
  // …while the REAL markers were substituted (no live jinja leaks through).
  expect(html).not.toContain('{{ island_1_props }}')
  expect(html).not.toContain('{{ island_0_html')
})

// ── 3. Prebuilt dist boots WITHOUT the content dir (frozen manifest) ────────

test('dist boot without content dir — md routes serve from md-manifest.json', async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'brust-md-dist-'))
  const contentDir = path.join(FIXTURE_DIR, 'content')
  const movedDir = path.join(FIXTURE_DIR, 'content__moved')
  let proc2: ReturnType<typeof spawn> | undefined
  try {
    const build = spawnSync({
      cmd: [
        'bun',
        'run',
        resolve(REPO_ROOT, 'runtime/cli/index.ts'),
        'build',
        'index.ts',
        '--out-dir',
        distDir,
      ],
      cwd: FIXTURE_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (build.exitCode !== 0) {
      throw new Error(`brust build failed:\n${new TextDecoder().decode(build.stderr)}`)
    }
    expect(existsSync(path.join(distDir, 'md-manifest.json'))).toBe(true)
    // react/react-dom stay external in the dist bundle — resolve from the repo.
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(distDir, 'node_modules'), 'dir')

    // The acceptance condition: the markdown SOURCE is gone at boot.
    renameSync(contentDir, movedDir)

    proc2 = spawn({
      cmd: ['bun', 'run', path.join(distDir, 'index.js')],
      cwd: FIXTURE_DIR, // island sourcePaths are project-relative to the build cwd
      env: { ...process.env, BRUST_PORT: '3822', BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    await waitForReady('http://127.0.0.1:3822')

    const home = await getOk('http://127.0.0.1:3822', '/docs')
    expect(home).toContain('<title>Docs Home</title>')
    expect(home).toContain('<table>')

    const intro = await getOk('http://127.0.0.1:3822', '/docs/intro')
    expect(intro).toContain('<title>Intro</title>')
    expect(intro).toContain(`data-brust-island="${COUNTER_ID}"`)
    expect(intro).toContain('&quot;start&quot;:5')
    expect(intro).toContain('data-testid="counter"') // SSR island inner HTML
    expect(intro).toContain('{% endraw %}') // fence text survives the dist path too

    const nested = await getOk('http://127.0.0.1:3822', '/docs/query/where')
    expect(nested).toContain('<title>Query Where</title>')
  } finally {
    if (proc2) {
      proc2.kill('SIGINT')
      try {
        await proc2.exited
      } catch {
        // already exited
      }
    }
    if (existsSync(movedDir)) renameSync(movedDir, contentDir)
    await rm(distDir, { recursive: true, force: true })
  }
}, 120_000)

// ── 4. SSG — /docs/* export statically, island chunk URLs resolve ───────────

test('SSG export of /docs/* — pages + island chunks 200 from a dumb static host', async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'brust-md-ssg-dist-'))
  const staticOut = await mkdtemp(path.join(tmpdir(), 'brust-md-ssg-out-'))
  let server: ReturnType<typeof Bun.serve> | undefined
  const savedCwd = process.cwd()
  try {
    const build = spawnSync({
      cmd: [
        'bun',
        'run',
        resolve(REPO_ROOT, 'runtime/cli/index.ts'),
        'build',
        'index.ts',
        '--out-dir',
        distDir,
      ],
      cwd: FIXTURE_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (build.exitCode !== 0) {
      throw new Error(`brust build failed:\n${new TextDecoder().decode(build.stderr)}`)
    }
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(distDir, 'node_modules'), 'dir')

    // Curated crawl (the shared fixture deliberately ships crash/auth routes a
    // blanket `--ssg` crawl would trip over — same approach as tests/ssg.test.ts;
    // exportStatic IS the `brust build --ssg` implementation). chdir to the
    // fixture so the crawler's dist server resolves project-relative island
    // sourcePaths (exportStatic inherits this process's cwd).
    const mdRoute = (fullPath: string): FlatRouteLike => ({ fullPath, chain: [{}] })
    process.chdir(FIXTURE_DIR)
    const result = await exportStatic({
      distDir,
      entryDir: FIXTURE_DIR,
      staticOut,
      routes: collectStaticPaths([
        mdRoute('/docs'),
        mdRoute('/docs/intro'),
        mdRoute('/docs/query/where'),
      ]),
    })
    process.chdir(savedCwd)
    expect([...result.written].sort()).toEqual([
      'docs/index.html',
      'docs/intro/index.html',
      'docs/query/where/index.html',
    ])

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const pathname = decodeURIComponent(new URL(req.url).pathname)
        const direct = Bun.file(path.join(staticOut, pathname))
        if (await direct.exists()) return new Response(direct)
        const page = Bun.file(path.join(staticOut, pathname, 'index.html'))
        if (await page.exists()) return new Response(page)
        return new Response('not found', { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${server.port}`

    const intro = await getOk(base, '/docs/intro')
    expect(intro).toContain('<title>Intro</title>')
    expect(intro).toContain(`data-brust-island="${COUNTER_ID}"`)
    expect(intro).toContain('data-testid="counter"') // SSR inner survives into static HTML
    await getOk(base, '/docs')
    await getOk(base, '/docs/query/where')

    // Hydration chain: bootstrap → _islands.js map → the page's island chunk.
    await getOk(base, '/_brust/islands/_bootstrap.js')
    const map = await getOk(base, '/_brust/islands/_islands.js')
    const mapObj = JSON.parse(map.replace(/^export default /, '').trim()) as Record<string, string>
    const chunkUrl = mapObj[COUNTER_ID]
    expect(`${COUNTER_ID} → ${chunkUrl}`).not.toBe(`${COUNTER_ID} → undefined`)
    await getOk(base, chunkUrl as string)
  } finally {
    process.chdir(savedCwd)
    server?.stop(true)
    await rm(distDir, { recursive: true, force: true })
    await rm(staticOut, { recursive: true, force: true })
  }
}, 180_000)
