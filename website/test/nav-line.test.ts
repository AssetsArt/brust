// website/test/nav-line.test.ts — brust.dev's own loading line (components/NavLine.tsx) reads the built-in navigation
// store: the framework's bar is off, the line shows during a slow navigation and hides after it, and nothing under
// website/ listens to the brust:nav:* events itself (a grep gate).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { app, build, freshOut, HOOK_MS, serve, type Server, TEST_MS, until } from './harness'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined

beforeAll(async () => {
  const out = freshOut('navline')
  build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('navline')
}, HOOK_MS)

const line = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-nav-line]')
    return el ? { state: el.getAttribute('data-state'), to: el.getAttribute('data-to'), scale: new DOMMatrixReadOnly(getComputedStyle(el).transform).a } : null
  })

test('first paint: the line is idle and the framework bar is turned off', async () => {
  const html = await (await fetch(`${base}/docs/routing`)).text()
  expect(html).toMatch(/<html [^>]*data-brust-progress="off"/)
  expect(html).toMatch(/<div [^>]*data-nav-line[^>]*data-state="idle"/)
})

test('a slow navigation shows the line and no framework bar, and the line hides after it', async () => {
  const page = await (await browser!.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`)
  })
  await page.goto(`${base}/docs/routing`)
  await page.waitForSelector('[data-nav-line][x-data]', { state: 'attached' })
  expect(await line(page)).toEqual({ state: 'idle', to: '', scale: 0 })
  // hold the next page's document for a while, the way a slow loader does
  await page.route('**/docs/store', async (route) => {
    await Bun.sleep(1200)
    await route.continue()
  })
  await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[href="/docs/store"]')?.click())
  const during = await until(() => line(page), (v) => v?.state === 'loading' && v.scale > 0.05)
  expect(during).toMatchObject({ state: 'loading', to: '/docs/store' })
  expect(during!.scale).toBeGreaterThan(0.05)
  expect(await page.locator('[data-brust-bar]').count()).toBe(0)
  const after = await until(() => line(page), (v) => v?.state === 'idle' && v.scale === 0)
  expect(after).toEqual({ state: 'idle', to: '', scale: 0 })
  expect(new URL(page.url()).pathname).toBe('/docs/store')
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
  expect(errors).toEqual([])
  await page.context().close()
}, TEST_MS)

test('a navigation that is quick never paints the line', async () => {
  const page = await (await browser!.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${base}/docs/routing`)
  await page.waitForSelector('[data-nav-line][x-data]', { state: 'attached' })
  await page.evaluate(() => {
    const w = window as unknown as { __max: number }
    w.__max = 0
    const el = document.querySelector('[data-nav-line]')!
    const tick = () => {
      w.__max = Math.max(w.__max, new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
      requestAnimationFrame(tick)
    }
    tick()
  })
  await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[href="/docs/store"]')?.click())
  await page.waitForFunction(() => location.pathname === '/docs/store' && !document.documentElement.hasAttribute('data-brust-loading'))
  await Bun.sleep(400)
  expect(await page.evaluate(() => (window as unknown as { __max: number }).__max)).toBeLessThan(0.02)
  await page.context().close()
}, TEST_MS)

// The site uses the store, never a hand-written listener. The Navigation docs page quotes the low-level events as
// documentation (code in a string), so it is the one file allowed to spell them; this test spells the pattern in pieces.
test('grep gate: no addEventListener of a brust:nav event under website/', () => {
  const pattern = new RegExp(`addEventListener\\(\\s*['"\`]brust:${'nav'}`)
  const allowed = new Set(['pages/docs/Navigation.tsx', 'test/nav-line.test.ts'])
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', 'public'].includes(name) || name.startsWith('dist-test-')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(tsx?|css|md|html|js)$/.test(name) && !allowed.has(relative(app, p)) && pattern.test(readFileSync(p, 'utf8'))) hits.push(relative(app, p))
    }
  }
  walk(app)
  expect(hits).toEqual([])
})
