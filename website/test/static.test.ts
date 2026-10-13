// website/test/static.test.ts — the site as it ships: `brust build --target static` (gaps round L9) writes one file per
// route; serve dist/static the way Cloudflare Pages does (a path answers its file, or <path>.html, or 404.html with
// status 404) and drive it in Chromium: every route 200 and an unknown one 404, no failed request, no request that is
// not a file, no page error, light and dark at 400px with no sideways scroll, the canonical/og:url tags, sitemap.xml
// and llms.txt from lib/site.ts, and the four browser-only demos (team, cache probe, loader lookup, landing tiers).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { absolute, SITE_URL, siteRoutes } from '../lib/site'
import { app, bin, HOOK_MS, ready, TEST_MS, until, WAIT_MS } from './harness'

const dist = join(app, 'dist-test-static')
const out = join(dist, 'static')
interface Ssg {
  pages: { path: string; file: string; routeId: string }[]
  redirects: unknown[]
  skipped: { routeId: string; pattern: string }[]
  notFound: { file: string; routeId: string }
  warnings: unknown[]
}
let ssg: Ssg
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
  rmSync(dist, { recursive: true, force: true })
  const gen = Bun.spawnSync(['bun', 'scripts/gen-meta.ts'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (gen.exitCode !== 0) throw new Error(`gen-meta failed:\n${gen.stderr.toString()}`)
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static', '--out-dir', 'dist-test-static'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  const log = b.stdout.toString() + b.stderr.toString()
  if (b.exitCode !== 0) throw new Error(`brust build --target static failed:\n${log}`)
  // the react demos warn hook-unsupported on purpose; any other warning or error is a failure
  const other = log.split('\n').filter((l) => /^(warning|error) /.test(l) && !/^warning hook-unsupported /.test(l))
  expect(other).toEqual([])
  ssg = JSON.parse(readFileSync(join(out, 'ssg.json'), 'utf8'))
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
  rmSync(dist, { recursive: true, force: true })
}, HOOK_MS)

test('the static build writes every nav route, skips the per-request demo route, and ships no server output', () => {
  const routes = siteRoutes()
  expect(routes.slice(0, 2)).toEqual(['/', '/docs'])
  expect(routes).toContain('/docs/caching')
  expect(ssg.pages.map((p) => p.path)).toEqual(routes)
  expect(ssg.skipped.map((s) => s.pattern)).toEqual(['/demo/pokemon/{name}'])
  expect(ssg.warnings).toEqual([])
  expect(ssg.notFound.file).toBe('404.html')
  for (const p of ssg.pages) expect([p.path, existsSync(join(out, p.file))]).toEqual([p.path, true])
  for (const f of ['404.html', '_headers', 'public/favicon.svg', 'public/sitemap.xml', 'public/llms.txt']) expect([f, existsSync(join(out, f))]).toEqual([f, true])
  // F130: the stylesheet is brust's own output (global CSS: one minified, hashed file), not a file served from public/
  expect(existsSync(join(out, 'public/app.css'))).toBe(false)
  const css = readdirSync(join(out, '_brust/client')).filter((f) => /^app-[0-9a-f]{10}\.css$/.test(f))
  expect(css.length).toBe(1)
  expect(readFileSync(join(out, '_brust/client', css[0]!), 'utf8').split('\n').length).toBeLessThanOrEqual(2)
  for (const f of ['manifest.json', 'index.js', 'jobs.js', 'actions.js', 'jinja', '_worker.js', '_routes.json']) expect([f, existsSync(join(out, f))]).toEqual([f, false])
})

test('served like Pages: every route 200 with its canonical and og:url, an unknown path and the skipped demo route 404', async () => {
  for (const r of siteRoutes()) {
    const res = await fetch(base + r)
    const html = await res.text()
    expect([r, res.status]).toEqual([r, 200])
    expect([r, html.includes(`<link rel="canonical" href="${absolute(r)}">`)]).toEqual([r, true])
    expect([r, html.includes(`<meta property="og:url" content="${absolute(r)}">`)]).toEqual([r, true])
  }
  for (const r of ['/docs/nope', '/demo/pokemon/eevee']) {
    const res = await fetch(base + r)
    expect([r, res.status]).toEqual([r, 404])
    expect(await res.text()).toContain('<title>')
  }
})

test('the first mention of Elysia on a page links to elysiajs.com in a new tab', () => {
  const link = '<a href="https://elysiajs.com/" target="_blank" rel="noopener noreferrer">'
  for (const f of ['index.html', 'docs/actions.html', 'docs/installation.html', 'docs/cloudflare/workers.html', 'docs/cookbook/form-action.html'])
    expect([f, readFileSync(join(out, f), 'utf8').includes(link)]).toEqual([f, true])
})

test('every built page, the 404 included, links the hashed stylesheet exactly once and never /public/app.css (F130)', () => {
  const pages = [...ssg.pages.map((p) => p.file), ssg.notFound.file]
  const hashed = readdirSync(join(out, '_brust/client')).find((f) => /^app-[0-9a-f]{10}\.css$/.test(f))!
  for (const f of pages) {
    const html = readFileSync(join(out, f), 'utf8')
    const links = [...html.matchAll(/<link [^>]*rel="stylesheet"[^>]*href="(\/_brust\/client\/[^"]+\.css)"/g)].map((m) => m[1])
    expect([f, links]).toEqual([f, [`/_brust/client/${hashed}`]])
    expect([f, /href="\/public\/app\.css"/.test(html)]).toEqual([f, false])
  }
  // the existing /_brust/client/* rule makes it immutable
  expect(readFileSync(join(out, '_headers'), 'utf8')).toMatch(/\/_brust\/client\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/)
})

test('the stylesheet is Tailwind CSS v4 in one hashed file: its layers, the site rules in components, a utility the markup uses (L31 R32.7)', () => {
  const css = readdirSync(join(out, '_brust/client')).filter((f) => f.endsWith('.css'))
  expect(css).toEqual([expect.stringMatching(/^app-[0-9a-f]{10}\.css$/)])
  const text = readFileSync(join(out, '_brust/client', css[0]!), 'utf8')
  expect(text).toContain('@layer theme,base,components,utilities')
  /** Every `@layer <name>{…}` block's body, braces matched, in order (one layer can have several blocks). */
  const layer = (name: string): string => {
    const open = `@layer ${name}{`
    const bodies: string[] = []
    for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
      let depth = 1
      let i = at + open.length
      for (; depth > 0; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0
      bodies.push(text.slice(at + open.length, i - 1))
    }
    expect([name, bodies.length > 0]).toEqual([name, true])
    return bodies.join('\n')
  }
  expect(layer('components')).toContain('.wrap{')
  // Preflight is undone rule by rule in base (R32.1), after Preflight itself
  const base = layer('base')
  expect(base.lastIndexOf('h1,h2,h3,h4,h5,h6{font-size:revert;font-weight:revert}')).toBeGreaterThan(base.indexOf('h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}'))
  expect(base.indexOf('h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}')).toBeGreaterThanOrEqual(0)
  // Tailwind scanned the markup: utilities the shell writes on purpose (theme-token colours, not words in prose) are in the
  // built CSS AND on the built pages. Prose can also yield a utility by accident (a word like `static`; bb gaps:docs-site G15),
  // so a bare "at least one" would pass without any markup using Tailwind.
  const used = new Set<string>()
  for (const f of [...ssg.pages.map((p) => p.file), ssg.notFound.file]) for (const m of readFileSync(join(out, f), 'utf8').matchAll(/class="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/)) used.add(c)
  const utilities = new Set([...layer('utilities').matchAll(/\.([a-z][\w-]*)\{/g)].map((m) => m[1]!))
  for (const u of ['text-ink-2', 'bg-sheet', 'border-rule', 'text-term-fg', 'bg-term']) expect([u, utilities.has(u), used.has(u)]).toEqual([u, true, true])
})

test('sitemap.xml and llms.txt list every route under the production origin', () => {
  const sitemap = readFileSync(join(out, 'public/sitemap.xml'), 'utf8')
  const llms = readFileSync(join(out, 'public/llms.txt'), 'utf8')
  expect(SITE_URL).toBe('https://brust.dev')
  for (const r of siteRoutes()) expect([r, sitemap.includes(`<loc>${absolute(r)}</loc>`)]).toEqual([r, true])
  expect(sitemap).not.toContain('127.0.0.1')
  expect(llms.startsWith('# brust\n')).toBe(true)
  for (const r of siteRoutes().slice(2)) expect([r, llms.includes(`](${absolute(r)})`)]).toEqual([r, true])
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
  test(`${scheme}, 400px: every static page loads with no failed or non-file request, no error, no sideways scroll`, async () => {
    const { ctx, page, w } = await context(scheme, 400)
    const over: [string, number][] = []
    for (const r of siteRoutes()) {
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
  await page.locator('.loader-demo button', { hasText: 'agumon' }).click()
  await page.locator('.loader-demo .vp-note', { hasText: 'Not in this demo set' }).waitFor()
  await page.goto(`${base}/docs/loaders?pokemon=Eevee#demo`, { waitUntil: 'networkidle' })
  await page.locator('.loader-demo h4', { hasText: 'Eevee' }).waitFor()
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, TEST_MS)

test('landing tier demos work from the static files: native catch card, react search island (useDeferredValue)', async () => {
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
