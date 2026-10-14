// R42.2 (F184) in real Chromium: pins what a click does while an island is still server HTML.
// The runtime hydrates an island when its React chunk has loaded and the browser is idle (island.ts); React attaches no
// listener before `hydrateRoot`, so a click in that window is dropped, exactly as on a React SSR page (plan
// 2026-10-15-hydration-timing, ruling Q3: "equal to React, documented"). A change that replays, loses the next click,
// or reports an error here is a behaviour change and needs its own ruling.
// Run alone: `bun test --timeout 120000 tests/server/hydration-timing.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/prop-path-children')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const out = 'dist-hydration-timing'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', out], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let text = ''
  while (!/\[brust\] ready/.test(text) || !/listening on (\S+)/.test(text)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${text}`)
    text += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(text)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, out), { recursive: true, force: true })
})

/** Holds every React chunk for `ms`, so the window between first paint and `hydrateRoot` is wide and deterministic. */
async function openSlow(ms: number) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.route('**/_brust/client/react-*.js', async (route) => { await Bun.sleep(ms); await route.continue() })
  await page.route('**/_brust/client/chunk-*.js', async (route) => { await Bun.sleep(ms); await route.continue() })
  await page.goto(`${base}/`, { waitUntil: 'commit' })
  return { page, errors }
}

test('a click on server HTML before hydrateRoot is dropped, and the next click after data-hydrated works', async () => {
  const { page, errors } = await openSlow(1500)
  const trigger = page.getByText('Toggle two')
  await trigger.waitFor({ state: 'visible' }) // server markup, painted
  expect(await page.locator('brust-island[data-hydrated="1"]').count()).toBe(0)
  await trigger.click() // the dead window: no React listener exists yet
  expect(await page.locator('brust-island[data-hydrated="1"]').count()).toBe(0)
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 3, undefined, { timeout: 20_000 })
  // Not replayed: hydration finished and the disclosure is still closed.
  await page.waitForTimeout(300)
  expect(await page.locator('[data-testid="disc-two"][data-state="open"]').count()).toBe(0)
  // The same control now works, once.
  await trigger.click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="open"]')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('without any delay the page hydrates every island and the first click works', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 3, undefined, { timeout: 15_000 })
  await page.getByText('Toggle two').click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="open"]')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
