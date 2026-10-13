// shadcn S1.1 (R34.11, F138b) in real Chromium: React islands imported by the binding their importer used. One page
// holds `export function Alpha`, `export const Beta = () => …`, `export { Gamma as Gam }` (three islands of ONE file),
// `Delta` re-exported through `ui/index.ts`, a default export re-exported as `Eps` (`export { default as Eps }`), and `Helper`,
// an island nothing exports, rendered by the exported static `Outer`.
// Each builds, is server-rendered, hydrates without a console error, and the islands of counters.tsx share one
// module instance (module state `total` counts clicks across them). Run alone:
// `bun test --timeout 120000 tests/server/named-export-islands.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/named-export-islands')
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
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 6, null, { timeout: 15_000 })
  return { page, errors }
}

const text = (page: import('playwright').Page, id: string) => page.locator(`[data-testid="${id}"]`).textContent()

test('every export form is its own island, server-rendered then hydrated', async () => {
  const res = await fetch(`${base}/`)
  const html = (await res.text()).replaceAll('<!-- -->', '')
  for (const label of ['alpha 0', 'beta 0', 'gamma 0', 'delta 0', 'epsilon 0', 'helper 0']) expect(html).toContain(label)
  const { page, errors } = await open('/')
  expect(await page.locator('brust-island').count()).toBe(6)
  for (const [id, label] of [['alpha', 'alpha 0'], ['beta', 'beta 0'], ['gamma', 'gamma 0'], ['delta', 'delta 0'], ['epsilon', 'epsilon 0'], ['helper', 'helper 0']]) expect(await text(page, id!)).toBe(label)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('islands of one file share one module instance; re-exported islands hydrate and keep their own state', async () => {
  const { page, errors } = await open('/')
  await page.locator('[data-testid="alpha"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="alpha"]')?.textContent === 'alpha 1')
  await page.locator('[data-testid="beta"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="beta"]')?.textContent === 'beta 2')
  await page.locator('[data-testid="gamma"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="gamma"]')?.textContent === 'gamma 3')
  await page.locator('[data-testid="delta"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="delta"]')?.textContent === 'delta 1')
  await page.locator('[data-testid="epsilon"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="epsilon"]')?.textContent === 'epsilon 1')
  await page.locator('[data-testid="helper"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="helper"]')?.textContent === 'helper 4')
  expect(await text(page, 'alpha')).toBe('alpha 1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
