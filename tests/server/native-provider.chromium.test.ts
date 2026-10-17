// 2c-2 in real Chromium: a hand-written disclosure (a Provider component with state, a toggle handler and `useId`, and
// consumers rendered inside it) lowers to ONE native component per call site (call-site specialisation, R34.122): no
// React island, first paint equals React's own render, and the toggle works on each instance independently.
// Run alone: `bun test --timeout 120000 tests/server/native-provider.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderColl, renderCtxV, renderDir, renderDirProvider, renderFwd, renderGate, renderHooks, renderHydr, renderInputs, renderLocalSpread, renderLocalSpreadRest, renderLoop, renderNested, renderNestedIds, renderPage, renderPoly, renderRender, renderRest, renderRoving, renderSame, renderSw, renderWrap } from '../../packages/brust/test/fixtures/native-provider/render'

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
    .replace(/(aria-controls|aria-describedby|id)="([^"]*)"/g, (_, k: string, v: string) => {
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
  expect(await page.locator('small').count()).toBe(1)
  await page.getByRole('button', { name: 'toggle' }).click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'true')
  // the trigger left the body in state: `!!document.body.closest('form')` is false
  await page.locator('small').waitFor({ state: 'hidden' })
  expect(await page.locator('input[type="hidden"]').getAttribute('value')).toBe('on')
  await page.getByRole('button', { name: 'toggle' }).click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'false')
  expect(await page.locator('input[type="hidden"]').count()).toBe(0)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('names of the page read in a specialised Provider\'s content cross as inputs: text, and a handler', async () => {
  const html = await (await fetch(`${base}/inputs`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderInputs()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/inputs`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('section[data-panel]')?.hasAttribute('x-data'))
  expect(await page.locator('#live').textContent()).toBe('0')
  await page.locator('#inc').click()
  // the handler lives in the page; the clone's content calls it, and the live read follows in both places
  await page.waitForFunction(() => document.querySelector('#outside')?.textContent === '1')
  await page.waitForFunction(() => document.querySelector('#live')?.textContent === '1')
  await page.locator('#inc').click()
  await page.waitForFunction(() => document.querySelector('#live')?.textContent === '2')
  // the Provider still toggles on its own
  await page.getByRole('button', { name: 'open' }).click()
  await page.waitForFunction(() => document.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true')
  expect(await page.getByText('body').isVisible()).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('an asChild consumer makes the caller\'s element the toggle', async () => {
  const html = await (await fetch(`${base}/poly`)).text()
  expect(html).not.toContain('brust-island')
  // Slot keeps the child's attributes first; the order of attributes carries no meaning.
  const sorted = (h: string): string => h.replace(/<(\w+)((?: [\w-]+="[^"]*")+)>/g, (_, tag: string, a: string) => `<${tag}${(a.match(/ [\w-]+="[^"]*"/g) ?? []).sort().join('')}>`)
  expect(sorted(plain(html))).toBe(sorted(plain(renderPoly())))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/poly`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('div[data-poly]')?.hasAttribute('x-data'))
  const link = page.locator('a[data-from="child"]')
  expect(await link.getAttribute('aria-expanded')).toBe('false')
  expect(await link.getAttribute('type')).toBe('button')
  expect(await page.getByText('poly body').isVisible()).toBe(false)
  await link.click()
  await page.waitForFunction(() => document.querySelector('a[data-from="child"]')?.getAttribute('aria-expanded') === 'true')
  expect(await page.getByText('poly body').isVisible()).toBe(true)
  await link.click()
  await page.waitForFunction(() => document.querySelector('a[data-from="child"]')?.getAttribute('aria-expanded') === 'false')
  expect(await page.getByText('poly body').isVisible()).toBe(false)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a ref passed to an inlined forwardRef child is bound on its element', async () => {
  const html = await (await fetch(`${base}/fwd`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderFwd()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/fwd`, { waitUntil: 'domcontentloaded' })
  // the ref cell and the callback each reached their own button once mounted
  await page.waitForFunction(() => document.querySelector('button[data-bound="ref"]') !== null && document.querySelector('button[data-bound="callback"]') !== null)
  expect(await page.locator('button[data-bound="ref"]').textContent()).toContain('one')
  expect(await page.locator('button[data-bound="callback"]').textContent()).toContain('two')
  await page.locator('button[data-bound="ref"]').click()
  await page.waitForFunction(() => document.querySelector('button[data-bound="ref"] i')?.textContent === '1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('content written in the Provider\'s own module is specialised and toggles', async () => {
  const html = await (await fetch(`${base}/same`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderSame()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/same`, { waitUntil: 'domcontentloaded' })
  const trigger = page.getByRole('button', { name: 'go' })
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'false')
  await trigger.click()
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'true')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('the call site\'s rest spread into the content crosses as an input and a plain helper paints without a job', async () => {
  const html = await (await fetch(`${base}/rest`)).text()
  expect(html).not.toContain('brust-island')
  expect(html).toContain('data-x="1"')
  // the order of attributes carries no meaning (the spread keys come sorted)
  const sorted = (h: string): string => h.replace(/<(\w+)((?: [\w-]+="[^"]*")+)>/g, (_, tag: string, a: string) => `<${tag}${(a.match(/ [\w-]+="[^"]*"/g) ?? []).sort().join('')}>`)
  expect(sorted(plain(html))).toBe(sorted(plain(renderRest())))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/rest`, { waitUntil: 'domcontentloaded' })
  const button = page.locator('button[data-x="1"]')
  await page.waitForFunction(() => document.querySelector('button[data-x="1"]')?.getAttribute('data-state') === 'unchecked')
  expect(await button.getAttribute('aria-label')).toBe('switch')
  await button.click()
  await page.waitForFunction(() => document.querySelector('button[data-x="1"]')?.getAttribute('data-state') === 'checked')
  expect(await button.getAttribute('aria-pressed')).toBe('true')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a live caller rest reaches the spread attributes after a click (Mellow F1)', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/rest-live`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('button[data-n]')?.getAttribute('data-n') === '0')
  await page.getByRole('button', { name: 'inc' }).click()
  await page.waitForFunction(() => document.querySelector('button[data-n]')?.getAttribute('data-n') === '1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a prop named like a template name (`loop`, `range`) prints through the props object and equals React', async () => {
  const html = await (await fetch(`${base}/loop/XYZ`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderLoop('XYZ')))
  expect(html).toContain('page:XYZ')
  expect(html).toContain('a:L:R')
  expect(html).toContain('x-XYZ')
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/loop/XYZ`, { waitUntil: 'domcontentloaded' })
  const button = page.locator('main button')
  await page.waitForFunction(() => document.querySelector('main button')?.textContent === '0')
  await button.click()
  await page.waitForFunction(() => document.querySelector('main button')?.textContent === '2')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('Radix\'s useId and useCallbackRef (imported, with their React-version fallbacks) lower natively and equal React', async () => {
  const html = await (await fetch(`${base}/hooks`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderHooks()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/hooks`, { waitUntil: 'domcontentloaded' })
  const out = page.locator('output')
  await page.waitForFunction(() => document.querySelectorAll('output')[1]?.textContent === 'idle')
  await page.getByRole('button', { name: 'b' }).click()
  await page.waitForFunction(() => document.querySelectorAll('output')[1]?.textContent === 'done')
  expect(await out.nth(0).textContent()).toBe('idle')
  // the id and its description stay paired
  const pair = await page.locator('button').nth(1).evaluate((b) => [b.id, b.getAttribute('aria-describedby')])
  expect(pair[1]).toBe(`${pair[0]}-log`)
  expect(pair[0]).toMatch(/^radix-/)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a context with a literal default read as a value (Radix\'s useDirection): the default without a Provider, the Provider\'s value under one, equal to React', async () => {
  for (const [path, want, expected] of [['/dir', ['ltr', 'rtl'], renderDir], ['/dir-provider', ['rtl', 'ltr'], renderDirProvider]] as const) {
    const html = await (await fetch(`${base}${path}`)).text()
    expect(html).not.toContain('brust-island')
    expect(plain(html)).toBe(plain(expected()))
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
    const boxes = page.locator('main > div')
    await page.waitForFunction(() => document.querySelectorAll('main > div').length === 2)
    expect(await boxes.nth(0).getAttribute('dir')).toBe(want[0])
    expect(await boxes.nth(1).getAttribute('dir')).toBe(want[1])
    await boxes.nth(0).click()
    await page.waitForFunction(() => document.querySelector('main > div')?.getAttribute('data-n') === '1')
    // the direction survives the update
    expect(await boxes.nth(0).getAttribute('dir')).toBe(want[0])
    expect(errors).toEqual([])
    await page.close()
  }
}, 60_000)

test('useIsHydrated (useSyncExternalStore of the hydration shape): false in the server markup like React, true once mounted, and the effect sees it', async () => {
  const html = await (await fetch(`${base}/hydr`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderHydr()))
  expect(html).toContain('data-h="n"')
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/hydr`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('main button')?.getAttribute('data-h') === 'y')
  await page.waitForFunction(() => document.querySelector('main button')?.getAttribute('data-seen') === 'effect')
  await page.locator('main button').click()
  await page.waitForFunction(() => document.querySelector('main button')?.textContent === '1')
  expect(await page.locator('main button').getAttribute('data-h')).toBe('y')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('useIsHydrated: an instance that mounts after the page booted (an x-if clone) starts true, like a React client mount; the server-rendered one runs its effect with false then true', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/hydr-if`, { waitUntil: 'domcontentloaded' })
  const first = page.locator('output[data-name="first"]')
  await page.waitForFunction(() => document.querySelector('output[data-name="first"]')?.getAttribute('data-log') === '01')
  expect(await first.getAttribute('data-h')).toBe('y')
  await page.getByRole('button', { name: 'toggle' }).click()
  const late = page.locator('output[data-name="late"]')
  await late.waitFor()
  // true from its first render, and its effect ran once, with true
  await page.waitForFunction(() => document.querySelector('output[data-name="late"]')?.getAttribute('data-log') === '1')
  expect(await late.getAttribute('data-h')).toBe('y')
  expect(await first.getAttribute('data-log')).toBe('01')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F304: a context field called in a handler and read in an effect: no island, markup equals React, the toggle and the effect follow the Provider', async () => {
  const html = await (await fetch(`${base}/ctxv`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderCtxV()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/ctxv`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('main p')?.getAttribute('data-seen') === 'n')
  await page.getByRole('button', { name: 't' }).click()
  await page.waitForFunction(() => document.querySelector('main section')?.getAttribute('data-open') === 'y')
  await page.waitForFunction(() => document.querySelector('main p')?.getAttribute('data-seen') === 'y')
  await page.getByRole('button', { name: 't' }).click()
  await page.waitForFunction(() => document.querySelector('main p')?.getAttribute('data-seen') === 'n')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F326: a local object that spreads the props among plain entries (Radix ToggleGroupItem\'s commonProps) equals React', async () => {
  const html = await (await fetch(`${base}/local-spread`)).text()
  expect(html).not.toContain('brust-island')
  // React prints a true boolean attribute as `disabled=""`, brust as `disabled`: the same HTML
  expect(plain(html)).toBe(plain(renderLocalSpread()).replace(/ (disabled)=""/g, ' $1'))
}, 60_000)

test('W1d PR 3: an early-return chain on a prop (Radix ToggleGroup\'s root shape): each type equals React, an invalid type is the server\'s own 500 with no message', async () => {
  for (const kind of ['single', 'multiple']) {
    const html = await (await fetch(`${base}/sw/${kind}`)).text()
    expect(html).not.toContain('brust-island')
    expect(plain(html)).toBe(plain(renderSw(kind)))
  }
  const bad = await fetch(`${base}/sw/other`)
  expect(bad.status).toBe(500)
  const body = await bad.text()
  expect(body).toBe('500 Internal Server Error')
  expect(body).not.toMatch(/Missing prop|Switch|threw/)
}, 60_000)

test('F327: the rest inside a local object that is only spread (Radix ToggleGroupImpl\'s commonProps) equals React, children included', async () => {
  const html = await (await fetch(`${base}/local-spread-rest`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderLocalSpreadRest()))
}, 60_000)

test('a recognised createCollection (R34.140): the markup equals React\'s, getItems() lists the items in document order with their data, a disabled item is skipped', async () => {
  const html = await (await fetch(`${base}/coll`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderColl()))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/coll`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('li[x-data]').length === 3 && document.querySelector('ul')?.getAttribute('x-data'))
  const items = page.locator('li')
  await items.nth(0).focus()
  await page.keyboard.press('ArrowDown')
  // B is disabled (focusable: false in its item data): focus goes A -> C, and the list had two focusable items
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('C')
  expect(await page.locator('ul').getAttribute('data-n')).toBe('2')
  await page.keyboard.press('ArrowDown')
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('A')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)


// F328c (ruling on note 84cd6abb, option a): a native Provider whose items each carry a `useId`. The Provider clone is inlined
// in its caller, so the caller's server records feed the items' ids: no island, the markup is React's (ids included), the ids
// are unique across the two groups, and they stay the same while the focus moves the roving tab stop.
test('F328c: items with a useId under a native Provider: markup equals React, unique stable ids, focus moves the tab stop', async () => {
  const html = await (await fetch(`${base}/roving`)).text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toBe(plain(renderRoving()))
  const ids = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map((m) => m[1]!)
  expect(ids.length).toBe(3)
  expect(new Set(ids).size).toBe(3)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/roving`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('div[role=group]')?.parentElement?.hasAttribute('x-data') || document.querySelector('div[role=group]')?.hasAttribute('x-data') || document.querySelector('brust-host[x-data]') !== null)
  const b = page.getByRole('button', { name: 'b' })
  await b.focus()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((x) => x.textContent === 'b')?.getAttribute('tabindex') === '0')
  expect(await page.getByRole('button', { name: 'a' }).getAttribute('tabindex')).toBe('-1')
  // the other group is its own Provider: unchanged
  expect(await page.getByRole('button', { name: 'c' }).getAttribute('tabindex')).toBe('-1')
  const after = await page.$$eval('button', (bs) => bs.map((x) => x.id))
  expect(after).toEqual(ids)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F328c: a native wrapper whose props change on the client keeps the page React for a child that derives from them (named fallback, markup equals React)', async () => {
  for (const tone of ['calm', 'Ab ']) {
    const html = await (await fetch(`${base}/wrap/${encodeURIComponent(tone)}`)).text()
    expect(plain(html.replace(/<brust-island\b[^>]*>/g, '').replace(/<\/brust-island>/g, ''))).toBe(plain(renderWrap(tone)))
  }
}, 60_000)
