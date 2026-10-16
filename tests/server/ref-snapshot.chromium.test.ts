// B4 in real Chromium: a useRef that is never written and only read as `.current` in the render is its first value.
// First paint equals React's render, and clicks (which re-render the count) leave the checkbox state alone.
// F277: a cell nothing sets is not reactive: a parent's changing prop read only for such a cell's first value does not
// link the child (Bubble, First), and a live style object on a static child's element binds as an object (Sized). Run alone: `bun test --timeout 120000 tests/server/ref-snapshot.chromium.test.ts`.
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

/** The style declarations of the `sized` input as a sorted set (a style object reaches jinja as a key-sorted map). */
const sizedStyle = (html: string): string[] =>
  (/\sstyle="([^"]*)"/.exec(/<input[^>]*data-testid="sized"[^>]*>/.exec(html)?.[0] ?? '')?.[1] ?? '').split(';').filter(Boolean).sort()

/** The text of the `first` button without React's text separators or brust's spans. */
const firstText = (html: string): string => (/data-testid="first"[^>]*>(.*?)<\/button>/.exec(html)?.[1] ?? '').replace(/<!-- -->|<[^>]+>/g, '')

test("first paint's checkboxes equal React's own render", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const served = checkedAttrs(html)
  const reactHtml = renderPage()
  const react = checkedAttrs(reactHtml)
  expect(react).toEqual([true, false, true, true, false])
  expect(served).toEqual(react)
  expect(sizedStyle(html)).toEqual(sizedStyle(reactHtml))
  expect(sizedStyle(reactHtml)).toEqual(['opacity:0.5', 'position:relative', 'width:10px'])
  expect(firstText(html)).toBe(firstText(reactHtml))
})

test('F277: a prop read only for a fixed cell links nothing; a live style object binds on the child element', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const bubble = /<input[^>]*data-testid="bubble"[^>]*>/.exec(html)![0]
  expect(bubble).not.toContain('x-data')
  expect(bubble).not.toContain('x-bind')
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
      }
    })
  for (const w of [20, 30]) {
    await page.locator('[data-testid="toggle"]').click()
    await page.waitForFunction((t) => document.querySelector('[data-testid="toggle"]')?.textContent === t, String(w))
    // React: the snapshot props keep the first render's values; the style object follows `w`.
    expect(await state()).toEqual({ toggle: String(w), bubble: true, first: '10:0', width: `${w}px`, position: 'relative', opacity: '0.5' })
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
