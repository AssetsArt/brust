// website/test/export.test.ts — the static export (plan R8): run `scripts/export-static.ts`, serve out/ the way
// Cloudflare Pages does (a path answers its file, or <path>.html, or 404.html with status 404), and drive it in
// Chromium: every route 200 and an unknown one 404, no failed request, no request that is not a file, no page error,
// light and dark at 400px with no sideways scroll, and the four browser-only demos (team, cache probe, loader lookup,
// landing tiers).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { type ExportResult, exportRoutes, exportStatic, fileFor } from '../scripts/export-static'
import { app, HOOK_MS, ready, TEST_MS, until, WAIT_MS } from './harness'

const dist = join(app, 'dist-test-export')
const out = join(app, 'out-test-export')
let result: ExportResult
let pages: ReturnType<typeof Bun.serve> | undefined
let base = ''
let browser: Browser | undefined

/** Pages' lookup for one path, or null for the 404 page. */
function resolve(pathname: string): string | null {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  for (const f of [rel, `${rel}.html`, rel === '' ? 'index.html' : null]) {
    if (f === null || f.includes('..')) continue
    const p = join(out, f)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

beforeAll(async () => {
  result = await exportStatic({ dist, out })
  pages = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const file = resolve(new URL(req.url).pathname)
      return file ? new Response(Bun.file(file)) : new Response(Bun.file(join(out, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  base = `http://127.0.0.1:${pages.port}`
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await pages?.stop(true)
  for (const d of [dist, out]) rmSync(d, { recursive: true, force: true })
}, HOOK_MS)

test('the route list is derived from lib/nav.ts and lib/pokemon.ts, and every route has its file', () => {
  const routes = exportRoutes()
  expect(routes.slice(0, 2)).toEqual(['/', '/docs'])
  expect(routes).toContain('/docs/caching')
  expect(routes).toContain('/demo/pokemon/eevee')
  expect(result.pages).toEqual([...routes, '*'])
  expect([fileFor('/'), fileFor('/docs'), fileFor('/docs/cookbook/hello-world')]).toEqual(['index.html', 'docs.html', 'docs/cookbook/hello-world.html'])
  for (const r of routes) expect([r, existsSync(join(out, fileFor(r)))]).toEqual([r, true])
  expect(existsSync(join(out, '404.html'))).toBe(true)
  // assets keep their URL paths; nothing outside /_brust and /public, and no server-side output is shipped
  expect(result.assets.every((a) => /^\/(_brust\/client|public)\//.test(a))).toBe(true)
  expect(result.assets).toContain('/public/app.css')
  for (const f of ['manifest.json', 'index.js', 'jobs.js', 'actions.js', 'jinja']) expect([f, existsSync(join(out, f))]).toEqual([f, false])
  // the only internal link to a missing page is the documented unknown Pokémon, which is the 404 page
  expect(result.dangling).toEqual(['/demo/pokemon/agumon'])
})

test('served like Pages: every route 200, an unknown path and an unknown Pokémon 404', async () => {
  for (const r of exportRoutes()) expect([r, (await fetch(base + r)).status]).toEqual([r, 200])
  for (const r of ['/docs/nope', '/demo/pokemon/agumon']) {
    const res = await fetch(base + r)
    expect([r, res.status]).toEqual([r, 404])
    expect(await res.text()).toContain('<title>')
  }
})

interface Watch {
  errors: string[]
  failed: string[]
  nonFile: string[]
}

async function context(scheme: 'light' | 'dark', width = 1280) {
  const ctx = await browser!.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const w: Watch = { errors: [], failed: [], nonFile: [] }
  page.on('pageerror', (e) => w.errors.push(`${page.url()}: ${e}`))
  page.on('requestfailed', (r) => w.failed.push(`${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && r.request().resourceType() !== 'document') w.failed.push(`${r.url()} ${r.status()}`)
  })
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.origin !== base) return
    // a document is a page route; anything else must be a file that exists under the same path
    if (r.resourceType() === 'document') return
    if (!(existsSync(join(out, u.pathname)) && statSync(join(out, u.pathname)).isFile())) w.nonFile.push(`${r.method()} ${u.pathname}${u.search}`)
  })
  return { ctx, page, w }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}, 400px: every exported page loads with no failed or non-file request, no error, no sideways scroll`, async () => {
    const { ctx, page, w } = await context(scheme, 400)
    const over: [string, number][] = []
    for (const r of exportRoutes()) {
      const res = await page.goto(base + r, { waitUntil: 'networkidle' })
      expect([r, res?.status()]).toEqual([r, 200])
      over.push([r, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)])
    }
    expect(over.filter(([, px]) => px > 0)).toEqual([])
    expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
    await ctx.close()
  }, TEST_MS * 4)
}

test('team demo: add six, the seventh is TeamFull 409, a reload keeps the team, the island removes one', async () => {
  const { ctx, page, w } = await context('light')
  await page.goto(`${base}/docs/actions`, { waitUntil: 'networkidle' })
  await ready(page, '.picker')
  const buttons = page.locator('.picker .demo-btn')
  for (let i = 0; i < 6; i++) {
    await buttons.nth(i).click()
    await page.locator('.picker .vp-note', { hasText: `team ${i + 1} / 6` }).waitFor()
  }
  await buttons.nth(6).click()
  await page.locator('.picker .vp-note', { hasText: '409 TeamFull: the team already has 6 members' }).waitFor()
  expect(await page.evaluate(() => localStorage.getItem('brust_docs_team')?.split('.').length)).toBe(6)
  // the Store page is painted empty (static), then the badge, the picker and the island fill from storage
  await page.goto(`${base}/docs/store`, { waitUntil: 'networkidle' })
  await ready(page, '.team-badge')
  await page.locator('.team-badge b', { hasText: '6' }).waitFor()
  await page.locator('brust-island[data-hydrated] .team-island').waitFor()
  expect(await until(() => page.locator('.team-island .demo-list li').count(), (n) => n === 6)).toBe(6)
  await page.locator('.team-island .demo-list button').first().click()
  await page.locator('.team-badge b', { hasText: '5' }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await ready(page, '.team-badge')
  await page.locator('.team-badge b', { hasText: '5' }).waitFor()
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)

test('team demo: blocked storage keeps an in-memory team without errors', async () => {
  const { ctx, page, w } = await context('dark')
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
  })
  await page.goto(`${base}/docs/actions`, { waitUntil: 'networkidle' })
  await ready(page, '.picker')
  await page.locator('.picker .demo-btn').first().click()
  await page.locator('.picker .vp-note', { hasText: 'team 1 / 6' }).waitFor()
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)

test('cache probe: labelled simulation, MISS HIT BYPASS, no timings', async () => {
  const { ctx, page, w } = await context('light')
  await page.goto(`${base}/docs/caching`, { waitUntil: 'networkidle' })
  expect(await page.locator('.probe').textContent()).toContain('Simulated in your browser: brust start sends these headers for real.')
  await ready(page, '.probe')
  await page.locator('.probe button').click()
  await page.locator('.probe li code').nth(2).waitFor()
  const rows = await page.locator('.probe li code').allTextContents()
  expect(rows.map((r) => r.split(' · ').slice(0, 2).join(' · '))).toEqual(['200 · x-brust-cache: MISS', '200 · x-brust-cache: HIT', '200 · x-brust-cache: BYPASS'])
  expect(rows.some((r) => /\bms\b/.test(r))).toBe(false)
  // the recorded transcript beside it is the real server's
  expect(await page.locator('pre', { hasText: "curl -sI 'http://127.0.0.1:" }).count()).toBe(1)
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)

test('loader lookup: buttons repaint the card and the URL, ?pokemon= is read on load', async () => {
  const { ctx, page, w } = await context('dark')
  await page.goto(`${base}/docs/loaders`, { waitUntil: 'networkidle' })
  await ready(page, '.loader-demo')
  await page.locator('.loader-demo button', { hasText: 'snorlax' }).click()
  await page.locator('.loader-demo h4', { hasText: 'Snorlax' }).waitFor()
  expect(new URL(page.url()).search).toBe('?pokemon=snorlax')
  expect(await page.locator('.loader-demo img').getAttribute('src')).toEndWith('/official-artwork/143.png')
  expect(await page.locator('.loader-demo .url span').first().textContent()).toBe('/docs/loaders?pokemon=snorlax')
  await page.locator('.loader-demo button', { hasText: 'agumon' }).click()
  await page.locator('.loader-demo .vp-note', { hasText: 'Not in this demo set' }).waitFor()
  await page.goto(`${base}/docs/loaders?pokemon=Eevee#demo`, { waitUntil: 'networkidle' })
  await page.locator('.loader-demo h4', { hasText: 'Eevee' }).waitFor()
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)

test('landing tier demos work from the static files: native catch card, react search island', async () => {
  const { ctx, page, w } = await context('light')
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  // the tabs and the card are native with no mount marker: click until a click lands (the tab is selected, the count moves)
  const tab = async (name: string) =>
    until(
      async () => {
        await page.locator(`#tab-${name}`).click()
        return page.locator(`#tab-${name}`).getAttribute('aria-selected')
      },
      (v) => v === 'true',
    )
  expect(await tab('native')).toBe('true')
  const card = page.locator('.catch')
  const count = await until(
    async () => {
      await card.locator('.demo-btn').click()
      return Number((await card.locator('.demo-btn span').textContent()) ?? '0')
    },
    (n) => n > 0,
  )
  expect(count).toBeGreaterThan(0)
  expect(await tab('react')).toBe('true')
  await page.locator('brust-island[data-hydrated] #demo-q').fill('char')
  await page.locator('.demo-list li', { hasText: 'Charmander' }).first().waitFor()
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)
