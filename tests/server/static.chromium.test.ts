// tests/server/static.chromium.test.ts — `brust build --target static` (gaps round L9) in real Chromium: the static
// files of packages/brust/test/fixtures/static-app served the way Cloudflare Pages does (a path answers its file, or
// <path>.html, or 404.html with status 404, `_redirects` applied). Every page loads with no failed request, no request
// that is not a file, no page error and no sideways scroll at 400px; the native toggle and the React island work from
// the static files alone. Ported from the docs site's export test (git show 4ab7b15:website/test/export.test.ts).
// Run alone: `bun test --timeout 120000 tests/server/static.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const fixture = join(import.meta.dir, '../../packages/brust/test/fixtures/static-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const out = join(fixture, 'dist/static')
let pages: ReturnType<typeof Bun.serve> | undefined
let base = ''
let browser: Browser | undefined
let paths: string[] = []

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
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static'], { cwd: fixture, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build --target static failed:\n${b.stderr.toString()}`)
  paths = (JSON.parse(readFileSync(join(out, 'ssg.json'), 'utf8')) as { pages: { path: string }[] }).pages.map((p) => p.path)
  const redirects = readFileSync(join(out, '_redirects'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '))
  pages = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      const r = redirects.find(([from]) => decodeURIComponent(from!) === decodeURIComponent(path))
      if (r) return new Response(null, { status: Number(r[2]), headers: { location: r[1]! } })
      const file = resolve(path)
      return file ? new Response(Bun.file(file)) : new Response(Bun.file(join(out, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  base = `http://127.0.0.1:${pages.port}`
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await pages?.stop(true)
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
})

async function context(width = 1280) {
  const ctx = await browser!.newContext({ viewport: { width, height: 800 } })
  const page = await ctx.newPage()
  const w = { errors: [] as string[], failed: [] as string[], nonFile: [] as string[] }
  page.on('pageerror', (e) => w.errors.push(`${page.url()}: ${e}`))
  page.on('console', (m) => {
    // Chromium logs the 404 *document* itself (expected there); a failed subresource is caught by `failed` below.
    const doc404 = m.text().startsWith('Failed to load resource') && m.location().url === page.url()
    if (m.type() === 'error' && !doc404) w.errors.push(`${page.url()}: console ${m.text()}`)
  })
  page.on('requestfailed', (r) => w.failed.push(`${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && r.request().resourceType() !== 'document') w.failed.push(`${r.url()} ${r.status()}`)
  })
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.origin !== base || r.resourceType() === 'document') return
    const p = join(out, decodeURIComponent(u.pathname))
    if (!(existsSync(p) && statSync(p).isFile())) w.nonFile.push(`${r.method()} ${u.pathname}${u.search}`)
  })
  return { ctx, page, w }
}

test('F392: every page renders in standards mode (document.compatMode is CSS1Compat), the 404 page too', async () => {
  const { ctx, page } = await context()
  const modes: [string, string][] = []
  for (const p of [...paths, '/no/such/page']) {
    await page.goto(base + p, { waitUntil: 'domcontentloaded' })
    modes.push([p, await page.evaluate(() => document.compatMode)])
  }
  expect(modes.filter(([, m]) => m !== 'CSS1Compat')).toEqual([])
  await ctx.close()
}, 120_000)

test('400px: every page and the 404 page load from files only, no error, no sideways scroll', async () => {
  const { ctx, page, w } = await context(400)
  const over: [string, number][] = []
  for (const p of paths) {
    const res = await page.goto(base + p, { waitUntil: 'networkidle' })
    expect([p, res?.status()]).toEqual([p, 200])
    over.push([p, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)])
  }
  const nf = await page.goto(`${base}/no/such/page`, { waitUntil: 'networkidle' })
  expect(nf?.status()).toBe(404)
  expect(await page.locator('h1').textContent()).toBe('Not found')
  expect(over.filter(([, px]) => px > 0)).toEqual([])
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, 120_000)

test('the native toggle and the React island work from the static files; the redirect lands on /docs', async () => {
  const { ctx, page, w } = await context()
  await page.goto(`${base}/poke/100%25`, { waitUntil: 'networkidle' })
  expect(await page.locator('h1.poke').textContent()).toBe('100%')
  await page.locator('brust-island[data-hydrated] .counter').waitFor()
  await page.locator('.counter').click()
  await page.locator('.counter', { hasText: '100% 1' }).waitFor()
  await page.locator('#theme').click()
  await page.locator('body[data-theme="dark"]').waitFor()
  expect(await page.locator('#theme').textContent()).toBe('dark')
  await page.goto(`${base}/old`, { waitUntil: 'networkidle' })
  expect(new URL(page.url()).pathname).toBe('/docs')
  expect(await page.locator('h1').textContent()).toBe('Docs')
  expect(w).toEqual({ errors: [], failed: [], nonFile: [] })
  await ctx.close()
}, 120_000)
