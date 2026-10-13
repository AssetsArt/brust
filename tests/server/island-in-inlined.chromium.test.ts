// L4 (gap-island-in-inlined, F108) in real Chromium: Page → Tiers (native, an x-data host) → <Search label="go"/>
// (a React island) and Page → Plain (static) → <Search label="plain"/>. Both islands are server-rendered from
// their wrapper's instance job, hydrate with no console error, and runtime-dom does not bind inside them: the
// native toggle re-renders its host while the island keeps its own React state. Run alone:
// `bun test --timeout 120000 tests/server/island-in-inlined.chromium.test.ts`. A per-row wrapper (Rows → Row → Search)
// renders one island per row from the row instance's job.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/island-in-inlined')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 2, null, { timeout: 15_000 })
  return { page, errors }
}

test('an island inside an inlined native and static component renders, hydrates and keeps its own state', async () => {
  const { page, errors } = await open('/')
  const go = page.locator('section brust-island [data-testid="search"]')
  const plain = page.locator('aside brust-island [data-testid="search"]')
  expect(await go.textContent()).toBe('go 0')
  expect(await plain.textContent()).toBe('plain 0')
  // The island's markup carries no runtime-dom directive, and the host did not adopt it.
  expect(await page.locator('brust-island [x-text], brust-island [x-on-click]').count()).toBe(0)
  await go.click()
  await page.waitForFunction(() => document.querySelector('section brust-island button')?.textContent === 'go 1')
  // The native host re-renders around the island; the island keeps its React state.
  await page.getByTestId('toggle').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="toggle"]')?.textContent === 'open')
  expect(await go.textContent()).toBe('go 1')
  await plain.click()
  await page.waitForFunction(() => document.querySelector('aside brust-island button')?.textContent === 'plain 1')
  expect(await go.textContent()).toBe('go 1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('an island inside an inlined per-row wrapper renders and hydrates once per row', async () => {
  const { page, errors } = await open('/rows')
  const buttons = page.locator('li brust-island [data-testid="search"]')
  expect(await buttons.allTextContents()).toEqual(['alpha 0', 'beta 0'])
  await buttons.nth(1).click()
  await page.waitForFunction(() => document.querySelectorAll('li brust-island button')[1]?.textContent === 'beta 1')
  expect(await buttons.allTextContents()).toEqual(['alpha 0', 'beta 1'])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
