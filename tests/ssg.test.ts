// Task 1.5 — static-host e2e. Builds the fixture app, exports a static site
// via the SSG pipeline, then serves `staticOut` with a dumb in-test file
// server (NO brust server running) and proves the site is self-contained:
// every page 200s, every asset URL the pages reference 200s (bootstrap,
// importmap chunks, css, the _islands.js map, and every hashed island chunk
// the pages' data-brust-island markers resolve to), and the Suspense route's
// static HTML carries the RESOLVED content, not just the fallback shell.
//
// The fixture app deliberately ships auth-gated (/protected, /admin) and
// crash routes that a blanket crawl would trip over (exportStatic fails the
// whole export on any non-200), so — same as runtime/cli/ssg.test.ts — the
// crawl set is curated and exportStatic is driven directly. The skip summary
// is asserted on exportStatic's returned `skipped` list.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { $ } from 'bun'
import { symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  collectStaticPaths,
  exportStatic,
  type FlatRouteLike,
  type SsgRouteDecision,
} from '../runtime/cli/ssg.ts'

const REPO = path.resolve(import.meta.dir, '..')
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'app')

function route(fullPath: string, chain: FlatRouteLike['chain'] = [{}]): FlatRouteLike {
  return { fullPath, chain }
}

let distDir: string
let proj: string // isolated build cwd so .brust mirrors never touch the repo
let staticOut: string
let result: { written: string[]; skipped: SsgRouteDecision[] }
let server: ReturnType<typeof Bun.serve>
let base: string

beforeAll(async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-host-dist-'))
  proj = await mkdtemp(path.join(tmpdir(), 'brust-ssg-host-proj-'))
  const build = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(
    FIXTURE,
    'index.ts',
  )} --out-dir ${distDir}`
    .cwd(proj)
    .quiet()
    .nothrow()
  if (build.exitCode !== 0) {
    throw new Error(`fixture build failed:\n${build.stdout}\n${build.stderr}`)
  }
  // react/react-dom stay external in the dist bundle — resolve them from the
  // repo (mirrors tests/cli-build.test.ts and runtime/cli/ssg.test.ts).
  symlinkSync(path.join(REPO, 'node_modules'), path.join(distDir, 'node_modules'), 'dir')

  staticOut = path.join(proj, 'static')
  // Curated fixture crawl: React-streaming pages that render unauthenticated
  // (incl. the Suspense route) + the routes SSG must SKIP ({param}, sse).
  result = await exportStatic({
    distDir,
    entryDir: FIXTURE,
    staticOut,
    routes: collectStaticPaths([
      route('/'),
      route('/store-demo'),
      route('/slow-suspense'),
      route('/blog/{slug}'),
      route('/sse-counter', [{ sse: () => {} }]),
    ]),
  })

  // Dumb static file host over staticOut: direct file hit first (assets),
  // then the <path>/index.html page fallback. No brust server involved.
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
  base = `http://127.0.0.1:${server.port}`
}, 180_000)

afterAll(async () => {
  server?.stop(true)
  for (const d of [distDir, proj]) {
    if (d) await rm(d, { recursive: true, force: true })
  }
})

async function get(url: string): Promise<Response> {
  const resp = await fetch(`${base}${url}`)
  expect(`${url} → ${resp.status}`).toBe(`${url} → 200`)
  return resp
}

/** All /_brust/... URLs a document (or script) references. */
function brustRefs(text: string): string[] {
  return [...new Set(text.match(/\/_brust\/[A-Za-z0-9_\-./]+/g) ?? [])]
}

test('skip summary mentions the {param} route (and the sse route)', () => {
  const skipped = new Map(result.skipped.map((s) => [s.fullPath, s.reason]))
  expect(skipped.get('/blog/{slug}')).toBe('dynamic-param')
  expect(skipped.get('/sse-counter')).toBe('sse')
})

test('every written page GETs 200 from the static host', async () => {
  expect([...result.written].sort()).toEqual([
    'index.html',
    'slow-suspense/index.html',
    'store-demo/index.html',
  ])
  // Pages are fetched by their URL shape (dir fallback), not the file path.
  await get('/')
  await get('/slow-suspense')
  await get('/store-demo')
})

test('every /_brust asset the pages reference GETs 200 (bootstrap, css, map, hashed chunks)', async () => {
  const pages = ['/', '/slow-suspense', '/store-demo']
  const refs = new Set<string>()
  const islandIds = new Set<string>()
  for (const p of pages) {
    const html = await (await get(p)).text()
    for (const r of brustRefs(html)) refs.add(r)
    for (const m of html.matchAll(/data-brust-island="([^"]+)"/g)) islandIds.add(m[1])
  }
  // The crawl set hosts at least one island (HelloWorld's Counter) → the
  // documents must wire the hydration entrypoints + the stylesheet.
  expect([...refs]).toContain('/_brust/islands/_bootstrap.js')
  expect([...refs]).toContain('/_brust/css/app.css')
  for (const r of refs) await get(r)

  // The bootstrap resolves plain ids → hashed chunks via the _islands.js map;
  // it is not referenced from HTML, so follow the chain explicitly.
  const bootstrap = await (await get('/_brust/islands/_bootstrap.js')).text()
  expect(brustRefs(bootstrap)).toContain('/_brust/islands/_islands.js')
  const map = await (await get('/_brust/islands/_islands.js')).text()
  const chunkUrls = brustRefs(map).filter((u) => /\/_brust\/islands\/.+_[0-9a-f]{8}\.js$/.test(u))
  expect(chunkUrls.length).toBeGreaterThan(0)
  for (const u of chunkUrls) await get(u)

  // Every island instance the pages mount resolves through the map to a
  // chunk that the static host actually serves.
  expect(islandIds.size).toBeGreaterThan(0)
  const mapObj = JSON.parse(map.replace(/^export default /, '').trim()) as Record<string, string>
  for (const id of islandIds) {
    const chunk = mapObj[id]
    expect(`${id} → ${chunk}`).not.toBe(`${id} → undefined`)
    await get(chunk)
  }
})

test('Suspense route static HTML contains the RESOLVED content, not a fallback shell', async () => {
  const html = await (await get('/slow-suspense')).text()
  expect(html).toContain('Resolved after 200ms via Suspense streaming')
  expect(html).toContain('data-testid="slow-content"')
})
