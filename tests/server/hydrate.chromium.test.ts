// tests/server/hydrate.chromium.test.ts — real Chromium: the react child's server HTML hydrates without a React
// mismatch (console.error) and is interactive. Run alone: `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { app, startPokedex } from './harness'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let srv: Awaited<ReturnType<typeof startPokedex>>
let browser: Browser
beforeAll(async () => { srv = await startPokedex(); browser = await chromium.launch() }, 180_000)
afterAll(async () => { await browser?.close(); try { await srv?.stop() } finally { rmSync(join(app, 'dist'), { recursive: true, force: true }) } })

test('/pokemon/pikachu hydrates the TeamBuilder island with no console error; "My team" toggles the panel; ThemeToggle flips data-mode', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))   // offline CI
  await page.goto(`${srv.base}/pokemon/pikachu`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
  expect(await page.locator('[data-testid="team-panel"]').count()).toBe(0)
  await page.getByRole('button', { name: /My team/ }).click()
  await page.locator('[data-testid="team-panel"]').waitFor({ state: 'visible' })
  expect(await page.locator('[data-testid="team-panel"] a').allTextContents()).toEqual(['Bulbasaur', 'Charmander'])
  await page.locator('[data-testid="team-panel"] button[aria-label="Remove"]').first().click()
  expect(await page.locator('[data-testid="team-count"]').textContent()).toBe('1')
  // Native hook on the same page (ThemeToggle: useState + useEffect).
  expect(await page.getAttribute('html', 'data-mode')).toBe('dark')
  await page.getByTestId('theme-toggle').click()
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'light', undefined, { timeout: 5000 }) // effects flush async
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
