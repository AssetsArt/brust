// website/test/packages-page.test.ts — /docs/packages: the sections and anchors, the IconAttrs demo (native tier, driven in Chromium),
// and every `source:` / `observed:` citation resolving to a file that exists (the lane/lucide-native ones name a branch, not a path here).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('packages')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  html = await (await fetch(`${base}/docs/packages`)).text()
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('packages')
}, HOOK_MS)

test('the page has every section, its table-of-contents entry and the sidebar link', () => {
  for (const id of ['package', 'icons', 'output', 'dynamic', 'defaults', 'try', 'provider', 'fallbacks', 'versions']) expect([id, html.includes(`id="${id}"`)]).toEqual([id, true])
  expect(html).toContain('href="#icons"')
  expect(html).toContain('Icons and packages')
  expect(html).toContain('href="/docs/packages"')
  for (const code of ['external-component', 'icon-dynamic-prop', 'icon-provider-dynamic', 'icon-render', 'LucideProvider']) expect([code, html.includes(code)]).toEqual([code, true])
})

test('tiers: the demo is native, the page is static', () => {
  expect(component(manifest, 'IconAttrs').tier).toBe('native')
  expect(component(manifest, 'IconsAndPackages').tier).toBe('static')
})

test('the demo (Chromium): undefined falls back to the default, a value is applied, no page errors', async () => {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}/docs/packages`, { waitUntil: 'networkidle' })
  await page.locator('[data-ready]').first().waitFor({ state: 'attached' })
  const attrs = page.getByTestId('icon-attrs')
  const svg = page.getByTestId('icon-stage').locator('svg')
  await attrs.scrollIntoViewIfNeeded()
  expect(await attrs.innerText()).toContain('width="16"')
  const selects = page.locator('select.demo-in')
  await selects.nth(0).selectOption('')
  expect(await until(() => attrs.innerText(), (t) => t.includes('width="24"'))).toContain('width="24" height="24" stroke="currentColor" stroke-width="2"')
  expect(await svg.getAttribute('width')).toBe('24')
  await selects.nth(0).selectOption('48')
  await selects.nth(1).selectOption('teal')
  await selects.nth(2).selectOption('3')
  expect(await until(() => attrs.innerText(), (t) => t.includes('stroke="teal"'))).toContain('width="48" height="48" stroke="teal" stroke-width="3"')
  expect([await svg.getAttribute('width'), await svg.getAttribute('stroke'), await svg.getAttribute('stroke-width')]).toEqual(['48', 'teal', '3'])
  expect(errors).toEqual([])
  await ctx.close()
}, TEST_MS)

test('every cited source exists, and every line resolves', () => {
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/IconsAndPackages.tsx'), 'utf8')
  const FULL: Record<string, string> = { 'children.rs': 'crates/brust-compiler/src/analyze/passes/children.rs' }
  let cites = 0
  for (const line of src.split('\n').filter((l) => /source:|observed:/.test(l))) {
    // lane/lucide-native files are not on this branch yet; they are cited by branch and sha on the line itself
    if (/lane\/lucide-native|lucide-native @/.test(line)) {
      expect([line, /@[0-9a-f]{8}/.test(line)]).toEqual([line, true])
      continue
    }
    let file = ''
    for (const m of line.matchAll(/((?:crates|packages|docs|tests)\/[\w./-]+\.\w+)|(?<![\w/.])([\w-]+\.rs)|:(\d+)(?:-(\d+))?/g)) {
      if (m[1]) {
        file = m[1]
        // the lucide fixtures and tests are on lane/lucide-native (named by sha on the line); they land on v2 with that lane
        if (/fixtures\/lucide|lucide\.chromium|lucide-native\.test|build-icons|icons\.rs/.test(file)) {
          file = ''
          continue
        }
        expect([file, existsSync(join(root, file))]).toEqual([file, true])
      } else if (m[2]) file = FULL[m[2]] ?? ''
      else if (m[3] && file) {
        const n = readFileSync(join(root, file), 'utf8').split('\n').length
        expect([file, m[0], Number(m[4] ?? m[3]) <= n]).toEqual([file, m[0], true])
        cites++
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(2)
})
