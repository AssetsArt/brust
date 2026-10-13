// website/test/docs-shell.test.ts — the docs shell: one route per nav entry, the shell's tiers, and in Chromium the
// sidebar/pager/edit link, the "On this page" scrollspy and the Copy button (no Clipboard API; timer restart).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { DOCS_HOME, EDIT_BASE, NAV, PAGES } from '../lib/nav'
import { app, build, component as componentOf, freshOut, HOOK_MS, type Manifest, ready, serve, type Server, TEST_MS, until } from './harness'

const coreVersion = JSON.parse(readFileSync(join(app, '../packages/brust/package.json'), 'utf8')).version as string
let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
const component = (name: string) => componentOf(manifest, name)

beforeAll(async () => {
  const out = freshOut('shell')
  // the react demos (landing PokemonSearch) legitimately print warning hook-unsupported: any other warning is a failure
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('shell')
}, HOOK_MS)

test('routes: /docs plus one /docs/{slug} per nav entry, in nav order; the canon slugs are present', () => {
  // the /demo/... routes belong to the Guide demos (guide.test.ts), not to the docs shell
  const patterns = manifest.routes.map((r) => r.pattern).filter((p) => !p.startsWith('/demo/'))
  // /docs/routes is a permanent redirect to /docs/routing (the blank template's starter links it), not a nav entry
  expect(patterns).toEqual(['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`), '/docs/routes', '*'])
  expect(NAV.map((g) => [g.group, g.items.length])).toEqual([
    ['Guide', 16],
    ['Cloudflare', 3],
    ['Cache adapters', 4],
    ['Cookbook', 5],
  ])
  for (const s of ['quickstart', 'routing', 'rendering-tiers', 'cookbook/hello-world']) expect(patterns).toContain(`/docs/${s}`)
})

test('tiers: the shell and Quickstart are static with no jobs; Toc and CopyButton are native', () => {
  for (const name of ['DocsLayout', 'Step', 'Note', 'Quickstart', 'Introduction']) {
    const c = component(name)
    expect([name, c.tier, c.jobs.length, c.client]).toEqual([name, 'static', 0, null])
  }
  for (const name of ['Toc', 'CopyButton']) expect([name, component(name).tier]).toEqual([name, 'native'])
})

test('every docs route is 200 with its title and current sidebar link; /docs is the docs home; unknown docs path 404', async () => {
  for (const p of PAGES) {
    const r = await fetch(`${base}/docs/${p.slug}`)
    expect([p.slug, r.status]).toEqual([p.slug, 200])
    const html = await r.text()
    expect(html).toContain(`<title>${p.title} · brust docs</title>`)
    // page loader keys merge over the layouts': the header version must survive every page
    expect(html).toContain(`<span class="v">${coreVersion}</span>`)
    expect(html).toContain(`<a href="/docs/${p.slug}" aria-current="page">${p.title}</a>`)
    expect(html).toContain(`<div class="crumbs">${p.group} / ${p.title}</div>`)
    expect(html).toContain(`${EDIT_BASE}${p.file}`)
  }
  const home = PAGES.find((p) => p.slug === DOCS_HOME)!
  const docs = await (await fetch(`${base}/docs`)).text()
  expect(docs).toContain(`<a href="/docs/${home.slug}" aria-current="page">${home.title}</a>`)
  expect((await fetch(`${base}/docs/nope`)).status).toBe(404)
}, TEST_MS)

test('pager: previous/next follow the nav order across groups; the ends have one side', async () => {
  const first = await (await fetch(`${base}/docs/introduction`)).text()
  expect(first).not.toContain('<span>Previous</span>')
  expect(first).toContain('<a class="next" href="/docs/installation"><span>Next</span><b>Installation</b></a>')
  const qs = await (await fetch(`${base}/docs/quickstart`)).text()
  expect(qs).toContain('<a href="/docs/installation"><span>Previous</span><b>Installation</b></a>')
  expect(qs).toContain('<a class="next" href="/docs/project-structure"><span>Next</span><b>Project structure</b></a>')
  const cross = await (await fetch(`${base}/docs/migrating`)).text()
  expect(cross).toContain('<a class="next" href="/docs/cloudflare/workers"><span>Next</span><b>Workers target</b></a>')
  const last = await (await fetch(`${base}/docs/cookbook/invalidate-the-cache`)).text()
  expect(last).not.toContain('<span>Next</span>')
})

test('On this page: the section being read is aria-current and the dot moves to it', async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  await ready(page, '.toc')
  const current = () => page.locator('.toc a[aria-current="location"]').allTextContents()
  expect(await until(current, (v) => v.join() === 'Check the requirements')).toEqual(['Check the requirements'])
  await page.evaluate(() => scrollTo(0, document.getElementById('run')!.offsetTop - 40))
  expect(await until(current, (v) => v.join() === 'Run it')).toEqual(['Run it'])
  const indY = () => page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.toc')!).getPropertyValue('--ind-y')))
  expect(await until(indY, (y) => y > 0)).toBeGreaterThan(0)
  await page.close()
}, TEST_MS)

test('CopyButton without the Clipboard API: says "Select to copy" and selects the code', async () => {
  const ctx = await browser!.newContext()
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined }))
  const page = await ctx.newPage()
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  await ready(page, 'figure.code button')
  const btn = page.locator('figure.code button').first()
  await btn.click()
  expect(await until(() => btn.textContent(), (t) => t === 'Select to copy')).toBe('Select to copy')
  expect(await page.evaluate(() => String(getSelection()))).toContain('bun --version')
  await ctx.close()
}, TEST_MS)

test('CopyButton: a second click restarts the 1.4 s reset (the first timer is cleared)', async () => {
  // Deterministic: without the Clipboard API the label is set synchronously in the click handler, so the
  // fake clock alone decides when each reset timer fires (the async writeText path would race the clock).
  const ctx = await browser!.newContext()
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined }))
  const page = await ctx.newPage()
  await page.clock.install()
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  const btn = page.locator('figure.code button').nth(1)
  await ready(page, 'figure.code button', 1)
  await btn.click()
  await page.clock.runFor(1000)
  expect(await btn.textContent()).toBe('Select to copy')
  await btn.click()
  await page.clock.runFor(1000) // 2.0 s after the first click: the first timer would have reset the label at 1.4 s
  expect(await btn.textContent()).toBe('Select to copy')
  await page.clock.runFor(500) // 1.5 s after the second click
  expect(await btn.textContent()).toBe('Copy')
  await ctx.close()
}, TEST_MS)

test('CopyButton with the Clipboard API: copies the shell commands without prompts and says Copied', async () => {
  const ctx = await browser!.newContext()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  const page = await ctx.newPage()
  await page.goto(`${base}/docs/quickstart`, { waitUntil: 'networkidle' })
  const btn = page.locator('figure.code button').nth(1)
  await ready(page, 'figure.code button', 1)
  await btn.click()
  await page.locator('figure.code button.done').waitFor()
  expect(await btn.textContent()).toBe('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('bun create @brust/app@latest my-app\ncd my-app && bun install')
  await ctx.close()
}, TEST_MS)
