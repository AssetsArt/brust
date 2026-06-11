// Task 1.7 — docs-site integration + SSG e2e (spec §Testing items 1–5).
// Builds example/docs via the REAL `brust build … --ssg` command shape
// (cwd = example/docs — the binding cwd contract: md content dir, island
// chunk-id hashing and .brust mirrors are all cwd-relative), then proves:
//
//   1. Build exits 0 and the static export is complete: EVERY md file in
//      content/ has a static page (count-agnostic — Plan 2 grows content),
//      plus Home, islands, css, search-index.json and the self-hosted fonts.
//   2. Static serve (dumb in-test file server, NO brust process): Home has
//      the grainient x-data host and NO _bootstrap.js (no islands on Home;
//      _directives.js IS present — behaviors exist app-wide); a docs page has
//      exactly one aria-current="page", pager links, and the SearchPalette
//      island host (content-addressed id hashed vs the example/docs cwd).
//   3. Search-index anchor parity: the /docs/introduction index entry's
//      anchors equal the rendered page's <h2>/<h3> ids byte-for-byte.
//   4. Source-boot smoke: `bun run index.ts` serves every page 200.
//
// The build deliberately lands in a TMP --out-dir (under the gitignored
// example/docs/.brust, INSIDE the repo so the SSG boot's external react
// resolves from the root node_modules) — the developer's example/docs/dist is
// never clobbered. The .brust/{jinja,islands} mirrors DO go to example/docs
// (cwd, gitignored, by design) and the source-boot smoke reads them.
//
// Ports 3831 (source boot) / 3832 (static file server) — suite-unique.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path, { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'
import { createHash } from 'node:crypto'
import { directiveName } from '../runtime/native/build.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DOCS_DIR = resolve(REPO_ROOT, 'example/docs')
const SOURCE_PORT = 3831
const STATIC_PORT = 3832
const SOURCE_BASE = `http://127.0.0.1:${SOURCE_PORT}`
const STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`

// Island chunk ids hash the source path RELATIVE TO THE BUILD CWD
// (= example/docs), same derivation as tests/md-routes.test.ts.
const PALETTE_ID = `SearchPalette_${createHash('sha256')
  .update('components/SearchPalette.tsx')
  .digest('hex')
  .slice(0, 8)}`
const GRAINIENT_DIRECTIVE = directiveName(
  resolve(DOCS_DIR, 'components/GrainientBackground.tsx'),
  DOCS_DIR,
)

/** Every md file under content/, as the URL it mounts at (mdUrlPath rules:
 * strip .md, `index` → the prefix, `a/index` → /docs/a). Count-agnostic by
 * construction — Plan 2 adds pages and this test keeps passing. */
function mdUrls(): string[] {
  const contentDir = path.join(DOCS_DIR, 'content')
  const urls: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel)
      else if (e.name.endsWith('.md')) {
        let route = childRel.replace(/\.md$/, '')
        if (route === 'index') route = ''
        else if (route.endsWith('/index')) route = route.slice(0, -'/index'.length)
        urls.push(route === '' ? '/docs' : `/docs/${route}`)
      }
    }
  }
  walk(contentDir, '')
  return urls.sort()
}

let outDir: string
let staticOut: string
let staticServer: ReturnType<typeof Bun.serve> | undefined
let sourceProc: ReturnType<typeof spawn> | undefined

async function getOk(base: string, urlPath: string): Promise<string> {
  const res = await fetch(`${base}${urlPath}`)
  expect(`${urlPath} → ${res.status}`).toBe(`${urlPath} → 200`)
  return res.text()
}

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (res.status === 200) return
      lastErr = new Error(`status ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}: ${String(lastErr)}`)
}

beforeAll(async () => {
  // Pre-flight: the jsx-rustc binary (native template emit shells out to it).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(`cargo build jsx-rustc failed (exit ${buildRustc.exitCode})`)
  }

  // The docs:build command shape, but into a tmp out-dir (+ explicit --ssg-out
  // so EVERYTHING lands under the tmp dir; default would be <outDir>/static
  // anyway — explicit per the harness contract).
  await mkdir(path.join(DOCS_DIR, '.brust'), { recursive: true })
  outDir = await mkdtemp(path.join(DOCS_DIR, '.brust', 'docs-site-test-'))
  staticOut = path.join(outDir, 'static')
  const build = spawnSync({
    cmd: [
      'bun',
      resolve(REPO_ROOT, 'runtime/cli/index.ts'),
      'build',
      'index.ts',
      '--out-dir',
      outDir,
      '--ssg',
      '--ssg-out',
      staticOut,
    ],
    cwd: DOCS_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (build.exitCode !== 0) {
    const out = build.stdout ? new TextDecoder().decode(build.stdout) : ''
    const err = build.stderr ? new TextDecoder().decode(build.stderr) : ''
    throw new Error(`brust build --ssg failed (exit ${build.exitCode}):\n${out}\n${err}`)
  }

  // Dumb static file host over staticOut (tests/ssg.test.ts pattern): direct
  // file hit first (assets), then the <path>/index.html page fallback.
  staticServer = Bun.serve({
    port: STATIC_PORT,
    async fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname)
      const direct = Bun.file(path.join(staticOut, pathname))
      if (await direct.exists()) return new Response(direct)
      const page = Bun.file(path.join(staticOut, pathname, 'index.html'))
      if (await page.exists()) return new Response(page)
      return new Response('not found', { status: 404 })
    },
  })

  // Source-boot smoke server (reads the .brust mirrors the build just wrote).
  sourceProc = spawn({
    cmd: ['bun', 'run', resolve(DOCS_DIR, 'index.ts')],
    cwd: DOCS_DIR,
    env: { ...process.env, BRUST_PORT: String(SOURCE_PORT), RUST_LOG: 'brust=warn' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(`${SOURCE_BASE}/`)
}, 300_000)

afterAll(async () => {
  if (sourceProc) {
    sourceProc.kill('SIGINT')
    try {
      await sourceProc.exited
    } catch {
      // already exited
    }
  }
  staticServer?.stop(true)
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

// ── 1. Static export is complete ────────────────────────────────────────────

test('every md file in content/ has a static page (and Home does too)', async () => {
  const urls = mdUrls()
  // Plan 2 content is complete: exactly 16 md pages (index + 15 docs). Bump
  // this lock when a page is added/removed — it catches accidental drops.
  expect(urls.length).toBe(16)
  expect(urls).toContain('/docs')
  expect(existsSync(path.join(staticOut, 'index.html'))).toBe(true) // Home
  for (const url of urls) {
    expect(`${url}: ${existsSync(path.join(staticOut, url.slice(1), 'index.html'))}`).toBe(
      `${url}: true`,
    )
    await getOk(STATIC_BASE, url)
  }
})

test('static export carries islands, css, search-index.json and fonts', async () => {
  expect(existsSync(path.join(staticOut, '_brust/islands/_bootstrap.js'))).toBe(true)
  expect(existsSync(path.join(staticOut, '_brust/islands/_directives.js'))).toBe(true)
  expect(existsSync(path.join(staticOut, '_brust/css/app.css'))).toBe(true)
  // search-index.json in BOTH dist/public (the build copy) and the static root
  // (public/ is root-mapped into staticOut).
  expect(existsSync(path.join(outDir, 'public/search-index.json'))).toBe(true)
  await getOk(STATIC_BASE, '/search-index.json')

  // Fonts: the built css references the self-hosted woff2 files and every
  // referenced URL resolves from the static host.
  const css = await getOk(STATIC_BASE, '/_brust/css/app.css')
  const fontUrls = [...new Set(css.match(/\/fonts\/[A-Za-z0-9_\-.]+\.woff2/g) ?? [])]
  expect(fontUrls.length).toBeGreaterThanOrEqual(8) // schibsted 400/500/700±italic + mono 400/600
  for (const u of fontUrls) {
    const res = await fetch(`${STATIC_BASE}${u}`)
    expect(`${u} → ${res.status}`).toBe(`${u} → 200`)
  }
})

// ── 2. Page shape: Home + docs chrome ───────────────────────────────────────

test('static Home — grainient x-data host, NO _bootstrap.js, directives wired', async () => {
  const html = await getOk(STATIC_BASE, '/')
  expect(html).toContain(`x-data="${GRAINIENT_DIRECTIVE}"`)
  // Home hosts no islands → the hydration bootstrap must NOT be baked…
  expect(html).not.toContain('_bootstrap')
  // …but the directive runtime IS (behaviors exist app-wide, force-baked).
  expect(html).toContain('/_brust/islands/_directives.js')
})

test('static docs page — exactly one aria-current, pager links, palette island host', async () => {
  const html = await getOk(STATIC_BASE, '/docs/introduction')
  // Sidebar: the page marks ITSELF current, nothing else.
  expect(html.match(/aria-current="page"/g)?.length).toBe(1)
  const current = /<a[^>]*aria-current="page"[^>]*>/.exec(html)?.[0] ?? ''
  // minijinja `| e` entity-encodes `/` in dynamic attribute values.
  expect(current).toContain('href="&#x2f;docs&#x2f;introduction"')
  // Pager: /docs (order 0) always precedes introduction → prev present; the
  // first page always has a next while ≥2 pages exist.
  expect(html).toContain('rel="prev"')
  expect(await getOk(STATIC_BASE, '/docs')).toContain('rel="next"')
  // The ONLY React island: idle-hydrated palette, no SSR markup (empty host).
  expect(html).toContain(`data-brust-island="${PALETTE_ID}"`)
  expect(html).toContain('data-brust-hydrate="idle"')
  expect(html).toContain('/_brust/islands/_bootstrap.js')
})

// ── 3. Search-index anchors == rendered heading ids, byte-for-byte ──────────

test('search-index anchors match the rendered /docs/introduction heading ids', async () => {
  const index = JSON.parse(await getOk(STATIC_BASE, '/search-index.json')) as {
    title: string
    path: string
    headings: { text: string; anchor: string }[]
  }[]
  const entry = index.find((e) => e.path === '/docs/introduction')
  expect(entry).toBeDefined()
  const anchors = (entry as NonNullable<typeof entry>).headings.map((h) => h.anchor)
  expect(anchors.length).toBeGreaterThanOrEqual(1) // introduction.md has an h2

  // Rendered ids, scoped to the md slot (the layout owns everything outside).
  const html = await getOk(STATIC_BASE, '/docs/introduction')
  const slotStart = html.indexOf('data-brust-md-slot')
  expect(slotStart).toBeGreaterThan(-1)
  const rendered = [...html.slice(slotStart).matchAll(/<h[23] id="([^"]*)"/g)].map((m) => m[1])
  expect(anchors).toEqual(rendered)
})

// ── 4. Source-boot smoke: all pages 200 ─────────────────────────────────────

test('source boot serves Home + every md page 200', async () => {
  const home = await getOk(SOURCE_BASE, '/')
  expect(home).toContain(`x-data="${GRAINIENT_DIRECTIVE}"`)
  for (const url of mdUrls()) {
    const html = await getOk(SOURCE_BASE, url)
    expect(html).toContain(`data-brust-island="${PALETTE_ID}"`)
  }
})
