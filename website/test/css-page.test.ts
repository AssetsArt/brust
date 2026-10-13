// website/test/css-page.test.ts — /docs/css (docs-css): the sections and anchors, the demo mounted and doing its one thing in Chromium, the tiers, every `source:` citation resolving.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { build, component, freshOut, HOOK_MS, type Manifest, ready, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('css-page')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  html = await (await fetch(`${base}/docs/css`)).text()
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('css-page')
}, HOOK_MS)

test('the page has every section, its table-of-contents entry, and the sidebar link', () => {
  for (const id of ['global', 'order', 'output', 'head', 'modules', 'fold', 'try', 'tailwind', 'dev', 'same']) expect([id, html.includes(`id="${id}"`)]).toEqual([id, true])
  for (const id of ['global', 'modules', 'fold', 'tailwind', 'dev']) expect([id, html.includes(`href="#${id}"`)]).toEqual([id, true])
  expect(html).toContain('href="/docs/css"')
  for (const t of ['tailwind-missing', 'css-module-class', 'css-asset-type', 'data-brust-css', 'the blank starter already has all three', '@tailwindcss/node', '@tailwindcss/oxide', '@reference', '.min.']) expect([t, html.includes(t)]).toEqual([t, true])
  expect(html).not.toContain('--tailwind')
  expect(html).not.toContain('bun-plugin-tailwind')
})

test('tiers: the page is static, the fold demo is native with no job', () => {
  expect(component(manifest, 'Css').tier).toBe('static')
  expect(component(manifest, 'ClassFold')).toMatchObject({ tier: 'native', jobs: [] })
})

test('every cited source line exists', () => {
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/Css.tsx'), 'utf8')
  const SHORT: Record<string, string> = { 'css.ts': 'packages/brust/src/build/css.ts', 'render.rs': 'crates/brust-core/src/render.rs', 'placement.rs': 'crates/brust-compiler/src/analyze/passes/placement.rs', 'css_module_fold.rs': 'crates/brust-compiler/tests/css_module_fold.rs' }
  let cites = 0
  for (const line of src.split('\n').filter((l) => /source:|observed:/.test(l))) {
    let file = ''
    for (const m of line.matchAll(/((?:crates|packages|docs)\/[\w./-]+\.\w+)|(?<![\w/.])([\w]+\.(?:rs|ts))(?=:|\s|\))|:(\d+)(?:-(\d+))?/g)) {
      if (m[1]) file = m[1]
      else if (m[2]) file = SHORT[m[2]] ?? file
      else if (m[3] && file) {
        expect([file, existsSync(join(root, file))]).toEqual([file, true])
        const n = readFileSync(join(root, file), 'utf8').split('\n').length
        expect([file, m[0], Number(m[4] ?? m[3]) <= n]).toEqual([file, m[0], true])
        cites++
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(25)
})

test('the fold demo (Chromium): a known class folds, an unknown one is the build error, the whole map is not folded, no page errors', async () => {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}/docs/css`, { waitUntil: 'networkidle' })
  await ready(page, '.matcher')
  const out = page.getByTestId('fold-out')
  const status = page.getByTestId('fold-status')
  expect(await out.innerText()).toBe('class="card_nBzD1A"')
  const input = page.getByLabel('Expression in the template')
  await input.fill("styles['title']")
  expect(await until(() => out.innerText(), (t) => t === 'class="title_nBzD1A"')).toBe('class="title_nBzD1A"')
  expect(await status.innerText()).toContain('no job')
  await input.fill('styles.nope')
  expect(await until(() => out.innerText(), (t) => t.startsWith('error css-module-class'))).toContain('class `nope` is not defined in ./Card.module.css')
  expect(await status.innerText()).toBe('build error')
  await input.fill('Object.keys(styles)')
  expect(await until(() => status.innerText(), (t) => t.startsWith('read at run time'))).toBe('read at run time, as before')
  expect(errors).toEqual([])
  await ctx.close()
}, TEST_MS)
