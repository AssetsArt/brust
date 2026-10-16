// B4 in real Chromium: a useRef that is never written and only read as `.current` in the render is its first value.
// First paint equals React's render, and clicks (which re-render the count) leave the checkbox state alone. Run alone: `bun test --timeout 120000 tests/server/ref-snapshot.chromium.test.ts`.
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

test("first paint's checkboxes equal React's own render", async () => {
  const served = checkedAttrs(await (await fetch(`${base}/`)).text())
  const react = checkedAttrs(renderPage())
  expect(react).toEqual([true, false, true])
  expect(served).toEqual(react)
})

test('clicking re-renders the count and keeps each checkbox as first painted', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="box"]')?.hasAttribute('x-data'))
  await page.locator('[data-testid="box"]').first().click()
  await page.waitForFunction(() => document.querySelector('b')?.textContent === '1')
  expect(await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.defaultChecked))).toEqual([true, false, true])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
