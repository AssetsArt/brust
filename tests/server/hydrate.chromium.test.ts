// tests/server/hydrate.chromium.test.ts — real Chromium: the react child's server HTML hydrates without a React
// mismatch (React 19 reports it as a pageerror, e.g. #418, and/or console.error) and is interactive. Run alone: `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { app, startPokedex } from './harness'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let srv: Awaited<ReturnType<typeof startPokedex>>
let browser: Browser
beforeAll(async () => { srv = await startPokedex(); browser = await chromium.launch() }, 180_000)
afterAll(async () => { await browser?.close(); try { await srv?.stop() } finally { rmSync(join(app, 'dist'), { recursive: true, force: true }) } })

/** Replace the shared roster with `ids` through the real actions (GET, DELETE each, POST each). */
async function seed(ids: number[]) {
  const cur = (await (await srv.action('/team')).json()) as { team: { id: number }[] }
  for (const m of cur.team) await srv.action(`/team/${m.id}`, { method: 'DELETE' })
  for (const id of ids) await srv.action('/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
}
/** What a page that never hydrated can tell us (R26.2): islands and their state, which `/_brust/` requests failed
 *  or came back non-2xx, whether the react chunk loaded, and the console so far. */
async function explain(page: Page, errors: string[], net: { failed: string[]; bad: string[]; chunks: string[]; doc?: string }): Promise<string> {
  const dom = await page
    .evaluate(() => ({
      title: document.title,
      bodyBytes: document.body?.innerHTML.length,
      islands: Array.from(document.querySelectorAll('brust-island')).map((h) => `${h.getAttribute('data-id')} hydrated=${h.getAttribute('data-hydrated')}`),
      scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')),
      visibility: document.visibilityState,
      queued: ((globalThis as { __brustIslands?: unknown[] }).__brustIslands ?? []).length,
      ric: typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback,
    }))
    .catch((e) => ({ evaluateFailed: String(e) }))
  return [
    `document: ${net.doc ?? 'no navigation response'}`,
    `url: ${page.url()}`,
    `dom: ${JSON.stringify(dom)}`,
    `react chunks loaded (200): ${JSON.stringify(net.chunks)}`,
    `requestfailed: ${JSON.stringify(net.failed)}`,
    `non-2xx under /_brust/: ${JSON.stringify(net.bad)}`,
    `console errors/warnings: ${JSON.stringify(errors)}`,
  ].join('\n  ')
}

/** A page that records console errors/warnings + pageerrors; `finish()` asserts none happened. */
async function open(path: string, hold?: { islandsMs: number }) {
  const page = await browser.newPage()
  const errors: string[] = []
  const net: { failed: string[]; bad: string[]; chunks: string[]; doc?: string } = { failed: [], bad: [], chunks: [] }
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => net.failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`))
  page.on('response', (r) => {
    if (!r.url().includes('/_brust/')) return
    if (r.status() < 200 || r.status() >= 300) net.bad.push(`${r.status()} ${r.url()}`)
    else if (/\/react-/.test(r.url())) net.chunks.push(r.url())
  })
  await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))   // offline CI
  // hold: delay every react island chunk (and do not wait for hydration), so native handlers run (and write the store) before islands hydrate.
  if (hold) await page.route(/\/_brust\/client\/react-/, async (r) => { await Bun.sleep(hold.islandsMs); await r.continue() })
  const nav = await page.goto(`${srv.base}${path}`, { waitUntil: hold ? 'commit' : 'domcontentloaded' })
  net.doc = nav ? `${nav.status()} ${nav.url()}` : undefined
  if (hold) await page.waitForSelector('[data-testid="unified-native-inc"]', { state: 'attached' })
  if (!hold) {
    try {
      await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    } catch (e) {
      // A timeout alone says nothing about why: report what the page knew (R26.2).
      throw new Error(`${path}: no brust-island hydrated within 15s\n  ${await explain(page, errors, net)}\n  cause: ${String(e).split('\n')[0]}`)
    }
  }
  await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1 })
  return { page, finish: async () => { expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1); expect(errors).toEqual([]); await page.close() } }
}
const text = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`).first().textContent()
const eventually = (page: Page, id: string, want: string) => page.waitForFunction(([i, w]) => document.querySelector(`[data-testid="${i}"]`)?.textContent?.trim() === w, [id, want] as const, { timeout: 8000 })

test('/pokemon/pikachu hydrates the TeamBuilder island with no console error; "My team" toggles the panel; ThemeToggle flips data-mode', async () => {
  await seed([1, 4])   // R4: the fresh DB is empty, so the old TEAM_SEED roster is seeded through the API
  const { page, finish } = await open('/pokemon/pikachu')
  expect(await page.locator('[data-testid="team-panel"]').count()).toBe(0)
  await page.getByRole('button', { name: /My team/ }).click()
  await page.locator('[data-testid="team-panel"]').waitFor({ state: 'visible' })
  expect(await page.locator('[data-testid="team-panel"] a').allTextContents()).toEqual(['Bulbasaur', 'Charmander'])
  await page.locator('[data-testid="team-panel"] button[aria-label="Remove"]').first().click()
  await eventually(page, 'team-count', '1')   // Remove goes through the actions client now, so the store update is async
  // Native hook on the same page (ThemeToggle: useState + useEffect).
  expect(await page.getAttribute('html', 'data-mode')).toBe('dark')
  await page.getByTestId('theme-toggle').click()
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'light', undefined, { timeout: 5000 }) // effects flush async
  await finish()
}, 60_000)

test('native Add to team updates the TeamBuilder island without a reload', async () => {
  await seed([])
  const { page, finish } = await open('/pokemon/pikachu?nocache=1')
  expect((await text(page, 'team-count'))?.trim()).toBe('0')
  await page.getByTestId('add-to-team').click()
  await eventually(page, 'team-count', '1')
  await eventually(page, 'add-to-team', 'In your team')
  await page.getByRole('button', { name: /My team/ }).click()
  await page.locator('[data-testid="team-panel"]').waitFor({ state: 'visible' })
  expect(await page.locator('[data-testid="team-panel"] a').allTextContents()).toEqual(['Pikachu'])
  await finish()
}, 60_000)

test('island Remove updates the native button without a reload', async () => {
  await seed([25])
  const { page, finish } = await open('/pokemon/pikachu?nocache=1')
  expect((await text(page, 'add-to-team'))?.trim()).toBe('In your team')
  await page.getByRole('button', { name: /My team/ }).click()
  await page.locator('[data-testid="team-panel"] button[aria-label="Remove"]').first().click()
  await eventually(page, 'add-to-team', 'Add to team')
  await eventually(page, 'team-count', '0')
  await finish()
}, 60_000)

test('Team Full at six: the seventh button is disabled', async () => {
  await seed([1, 4, 7, 39, 94, 143])
  const { page, finish } = await open('/pokemon/pikachu?nocache=1')
  expect((await text(page, 'add-to-team'))?.trim()).toBe('Team Full')
  expect(await page.getByTestId('add-to-team').isDisabled()).toBe(true)
  await finish()
}, 60_000)

test('/unified: native, island and node move together', async () => {
  const { page, finish } = await open('/unified?start=5')
  const all = async () => [await text(page, 'unified-island-count'), await text(page, 'unified-native-count'), await text(page, 'unified-node-count')].map((t) => t?.trim())
  expect(await all()).toEqual(['5', '5', '5'])
  await page.getByTestId('unified-native-inc').click()
  await eventually(page, 'unified-island-count', '6')
  expect(await all()).toEqual(['6', '6', '6'])
  await page.getByTestId('unified-island-inc').click()
  await eventually(page, 'unified-native-count', '7')
  expect(await all()).toEqual(['7', '7', '7'])
  await finish()
}, 60_000)

// G13: the native write lands while the island chunk is still in flight; the island must hydrate against the
// markup the server rendered (5), then catch up to the live value (6), with no #418.
test('/unified: a native store write before an island hydrates causes no hydration mismatch', async () => {
  const { page, finish } = await open('/unified?start=5', { islandsMs: 1500 })
  expect(await page.locator('brust-island[data-hydrated="1"]').count()).toBe(0)
  await page.getByTestId('unified-native-inc').click()
  await eventually(page, 'unified-native-count', '6')
  expect(await page.locator('brust-island[data-hydrated="1"]').count()).toBe(0)
  await eventually(page, 'unified-island-count', '6')
  await finish()
}, 60_000)

test('first paint equals the seeded value with JavaScript disabled (no flash of default)', async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  const page = await ctx.newPage()
  await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto(`${srv.base}/unified?start=5`, { waitUntil: 'domcontentloaded' })
  expect([await text(page, 'unified-island-count'), await text(page, 'unified-native-count'), await text(page, 'unified-node-count')].map((t) => t?.trim())).toEqual(['5', '5', '5'])
  await seed([25])
  await page.goto(`${srv.base}/pokemon/pikachu?nocache=1`, { waitUntil: 'domcontentloaded' })
  expect((await text(page, 'add-to-team'))?.trim()).toBe('In your team')
  expect((await text(page, 'team-count'))?.trim()).toBe('1')
  await ctx.close()
}, 60_000)
