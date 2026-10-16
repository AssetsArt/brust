// B4 in real Chromium: a useRef that is never written and only read as `.current` in the render is its first value.
// First paint equals React's render, and clicks (which re-render the count) leave the checkbox state alone.
// F277: a parent's changing prop read only for the first value of a cell nothing sets does not link a child that mounts
// with the parent and never again (Bubble, First), and a live style object on a child's element binds as an object
// (Sized). Mellow F1: a child that mounts later (under a condition, or below a component that does) reads the CURRENT
// prop, so it stays linked (Remount). Run alone: `bun test --timeout 120000 tests/server/ref-snapshot.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/ref-snapshot/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/ref-snapshot')
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

/** The `checked` attribute presence of each checkbox in the markup, in order. */
const checkedAttrs = (html: string): boolean[] => [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => /\schecked(?=[\s=>]|$)/.test(m[0]))

/** The `style` attribute of the element with `data-testid` `id`, as printed (declaration order matters: F277). */
const styleOf = (html: string, id: string): string =>
  /\sstyle="([^"]*)"/.exec(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? '')?.[1] ?? ''

/** The text of the `first` button without React's text separators or brust's spans. */
const firstText = (html: string): string => (/data-testid="first"[^>]*>(.*?)<\/button>/.exec(html)?.[1] ?? '').replace(/<!-- -->|<[^>]+>/g, '')

test("first paint's checkboxes equal React's own render", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const served = checkedAttrs(html)
  const reactHtml = renderPage()
  const react = checkedAttrs(reactHtml)
  expect(react).toEqual([true, false, true, true, false])
  expect(served).toEqual(react)
  expect(styleOf(reactHtml, 'sized')).toBe('width:10px;position:relative;opacity:0.5')
  expect(styleOf(html, 'sized')).toBe(styleOf(reactHtml, 'sized'))
  expect(styleOf(reactHtml, 'margin')).toBe('margin-top:5px;margin:0;display:block;width:10px')
  expect(styleOf(html, 'margin')).toBe(styleOf(reactHtml, 'margin'))
  expect(firstText(html)).toBe(firstText(reactHtml))
})

test('F277: a prop read only for a fixed cell links nothing; a live style object binds on the child element', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const bubble = /<input[^>]*data-testid="bubble"[^>]*>/.exec(html)![0]
  expect(bubble).not.toContain('x-props-bind')
  const first = /<button[^>]*data-testid="first"[^>]*>/.exec(html)![0]
  expect(first).toContain('x-data')
  expect(first).not.toContain('x-props-bind')
  const sized = /<input[^>]*data-testid="sized"[^>]*>/.exec(html)![0]
  expect(sized).toContain('x-props-bind')
  expect(sized).toContain('x-bind-style')

  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="first"]')?.hasAttribute('x-data'))
  const state = () =>
    page.evaluate(() => {
      const sized = document.querySelector<HTMLInputElement>('[data-testid="sized"]')!
      return {
        toggle: document.querySelector('[data-testid="toggle"]')!.textContent,
        bubble: document.querySelector<HTMLInputElement>('[data-testid="bubble"]')!.defaultChecked,
        first: document.querySelector('[data-testid="first"]')!.textContent,
        width: sized.style.width,
        position: sized.style.position,
        opacity: sized.style.opacity,
        marginTop: getComputedStyle(document.querySelector('[data-testid="margin"]')!).marginTop,
        marginWidth: (document.querySelector('[data-testid="margin"]') as HTMLElement).style.width,
      }
    })
  for (const w of [20, 30]) {
    await page.locator('[data-testid="toggle"]').click()
    await page.waitForFunction((t) => document.querySelector('[data-testid="toggle"]')?.textContent === t, String(w))
    // React: the snapshot props keep the first render's values; the style object follows `w`.
    expect(await state()).toEqual({ toggle: String(w), bubble: true, first: '10:0', width: `${w}px`, position: 'relative', opacity: '0.5', marginTop: '0px', marginWidth: `${w}px` })
  }
  await page.locator('[data-testid="first"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="first"]')?.textContent === '10:1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('clicking re-renders the count and keeps each checkbox as first painted', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="box"]')?.hasAttribute('x-data'))
  await page.locator('[data-testid="box"]').first().click()
  await page.waitForFunction(() => document.querySelector('b')?.textContent === '1')
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-testid="box"] input')].map((i) => (i as HTMLInputElement).defaultChecked))).toEqual([true, false, true])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('Mellow F1: a child that mounts after first paint takes the current prop for its fixed cell, as React does', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="open"]')?.closest('[x-data]') !== null)
  await page.waitForTimeout(100)
  const text = (id: string) => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.textContent ?? null, id)
  await page.locator('[data-testid="label"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="label"]')?.textContent === 'ax')
  await page.locator('[data-testid="open"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="cond"]') !== null)
  // React: the always-mounted instance kept 'a'; both later mounts read 'ax'.
  expect({ always: await text('always'), cond: await text('cond'), mid: await text('mid-initial') }).toEqual({ always: 'a', cond: 'ax', mid: 'ax' })
  // Close, change again, reopen: the later mounts read the new value again.
  await page.locator('[data-testid="open"]').click()
  await page.locator('[data-testid="label"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="label"]')?.textContent === 'axx')
  await page.locator('[data-testid="open"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="cond"]')?.textContent === 'axx')
  expect({ always: await text('always'), cond: await text('cond'), mid: await text('mid-initial') }).toEqual({ always: 'a', cond: 'axx', mid: 'axx' })
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
