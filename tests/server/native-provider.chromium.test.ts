// 2c-2 in real Chromium: a hand-written disclosure (a Provider component with state, a toggle handler and `useId`, and
// consumers rendered inside it) lowers to ONE native component per call site (call-site specialisation, R34.122): no
// React island, first paint equals React's own render, and the toggle works on each instance independently.
// Run alone: `bun test --timeout 120000 tests/server/native-provider.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderGate, renderNested, renderNestedIds, renderPage, renderRender } from '../../packages/brust/test/fixtures/native-provider/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/native-provider')
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

/** Markup with brust's own wrappers, directives and the hidden `x-if` placeholders removed, and ids renumbered in order. */
const plain = (html: string): string => {
  const ids = new Map<string, string>()
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<brust-host\b[^>]*>/g, '')
    .replace(/<\/brust-host>/g, '')
    .replace(/<div\b[^>]*\shidden[^>]*>[\s\S]*?<\/div>/g, '')
    .replace(/<brust-if\b[^>]*\shidden[^>]*>[\s\S]*?<\/brust-if>/g, '')
    .replace(/<\/?brust-if\b[^>]*>/g, '')
    .replace(/ (?:x-[\w-]+|data-id)="[^"]*"/g, '')
    .replace(/ x-[\w-]+='[^']*'/g, '')
    .replace(/(aria-controls|id)="([^"]*)"/g, (_, k: string, v: string) => {
      if (!ids.has(v)) ids.set(v, `ID${ids.size}`)
      return `${k}="${ids.get(v)}"`
    })
    .replace(/<script\b[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
}

test('the page lowers without a React island', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).not.toContain('brust-island')
  expect(html).not.toContain('react-disclosure')
})

test("first paint equals React's own render", async () => {
  const served = plain(await (await fetch(`${base}/`)).text())
  expect(served).toBe(plain(renderPage()))
})

test('each instance toggles on its own, with consistent ids', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  const first = page.getByRole('button', { name: 'First' })
  const second = page.getByRole('button', { name: 'Second' })
  await page.waitForFunction(() => document.querySelector('div[data-state]')?.hasAttribute('x-data'))
  await expect(first.getAttribute('aria-expanded')).resolves.toBe('false')
  await expect(second.getAttribute('aria-expanded')).resolves.toBe('true')
  // the native consumer with a ref and an effect of its own follows the Provider's state
  await page.waitForFunction(() => document.querySelector('p[data-seen]')?.getAttribute('data-seen') === 'closed')
  await first.click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-expanded') === 'true')
  await page.waitForFunction(() => document.querySelector('p[data-seen]')?.getAttribute('data-seen') === 'open')
  expect(await page.getByText('first body').isVisible()).toBe(true)
  const controls = await first.getAttribute('aria-controls')
  expect(await page.locator(`[id="${controls}"]`).count()).toBe(1)
  expect(await page.getByText('second body').isVisible()).toBe(true)
  await first.click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-expanded') === 'false')
  expect(await page.getByText('first body').isVisible()).toBe(false)
  expect(await page.getByText('second body').isVisible()).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('nested instances of one Provider component read their own frame', async () => {
  const served = plain(await (await fetch(`${base}/nested`)).text())
  expect(served).toBe(plain(renderNested()))
  const html = await (await fetch(`${base}/nested`)).text()
  expect(html).not.toContain('brust-island')
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/nested`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('section[data-panel]')?.hasAttribute('x-data'))
  const outer = page.getByRole('button', { name: 'Outer' })
  const inner = page.getByRole('button', { name: 'Inner' })
  expect(await inner.getAttribute('aria-expanded')).toBe('false')
  expect(await page.getByText('inner body').isVisible()).toBe(false)
  await inner.click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Inner')?.getAttribute('aria-expanded') === 'true')
  expect(await page.getByText('inner body').isVisible()).toBe(true)
  // the outer trigger flips the OUTER instance only: its content (and the inner instance in it) goes away and comes back
  await outer.click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Outer')?.getAttribute('aria-expanded') === 'false')
  expect(await page.getByRole('button', { name: 'Inner' }).count()).toBe(0)
  await outer.click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Outer')?.getAttribute('aria-expanded') === 'true')
  expect(await page.getByRole('button', { name: 'Inner' }).count()).toBe(1)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('nested instances that both carry a useId keep the island Provider with its children', async () => {
  const html = await (await fetch(`${base}/nested-ids`)).text()
  expect(plain(html.replace(/<brust-island\b[^>]*>/g, '').replace(/<\/brust-island>/g, ''))).toBe(plain(renderNestedIds()))
  const page = await browser.newPage()
  await page.goto(`${base}/nested-ids`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('brust-island')?.hasAttribute('data-hydrated') || true)
  await page.getByRole('button', { name: 'Inner' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Inner')?.getAttribute('aria-expanded') === 'true')
  expect(await page.getByText('inner body').isVisible()).toBe(true)
  await page.close()
}, 60_000)

test("a consumer under the Provider's own condition is switched by the Provider", async () => {
  const html = await (await fetch(`${base}/gate`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html.replace(/<brust-if\b[^>]*hidden[^>]*>[\s\S]*?<\/brust-if>/g, '').replace(/<\/?brust-if\b[^>]*>/g, ''))).toBe(plain(renderGate()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/gate`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('section')?.hasAttribute('x-data'))
  const consumer = page.getByRole('button', { name: 'consumer' })
  expect(await consumer.getAttribute('aria-pressed')).toBe('true')
  await page.getByTestId('own').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'consumer' && b.offsetParent !== null))
  await page.getByTestId('own').click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'consumer' && b.offsetParent !== null))
  expect(await consumer.getAttribute('aria-pressed')).toBe('true')
  // the consumer's own trigger flips the same state: it closes the gate from inside
  await consumer.click()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'consumer' && b.offsetParent !== null))
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a render prop the Provider only calls is spliced into the specialised Provider', async () => {
  const html = await (await fetch(`${base}/render`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderRender()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/render`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('button')?.hasAttribute('x-data'))
  const mirror = page.locator('input[type="hidden"]')
  expect(await mirror.count()).toBe(0)
  await page.getByRole('button', { name: 'toggle' }).click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'true')
  expect(await page.locator('input[type="hidden"]').getAttribute('value')).toBe('on')
  await page.getByRole('button', { name: 'toggle' }).click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'false')
  expect(await page.locator('input[type="hidden"]').count()).toBe(0)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
