// website/test/overflow.test.ts — no page scrolls sideways on a phone: every route in lib/nav.ts, /docs and / at
// 400px wide, light and dark, must have scrollWidth - innerWidth <= 0 (site-hardening, 2026-10-13).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type Browser, chromium } from 'playwright'
import { PAGES } from '../lib/nav'
import { build, freshOut, HOOK_MS, serve, type Server, TEST_MS } from './harness'

let srv: Server | undefined
let browser: Browser | undefined
const ROUTES = ['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`)]

beforeAll(async () => {
  const out = freshOut('overflow')
  build('routes.tsx', out)
  srv = await serve(out)
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('overflow')
}, HOOK_MS)

for (const scheme of ['light', 'dark'] as const) {
  test(`400px, ${scheme}: no route is wider than the viewport`, async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 900 }, colorScheme: scheme })
    const page = await ctx.newPage()
    const over: [string, number][] = []
    for (const r of ROUTES) {
      const res = await page.goto(`${srv!.base}${r}`, { waitUntil: 'load' })
      expect([r, res?.status()]).toEqual([r, 200])
      over.push([r, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)])
    }
    expect(over.filter(([, px]) => px > 0)).toEqual([])
    expect(over.length).toBe(ROUTES.length)
    await ctx.close()
  }, TEST_MS * 2)
}
