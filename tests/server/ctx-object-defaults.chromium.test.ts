// F431 in real Chromium: a page reading an object-default context with no Provider (`v.a`, `const { a, b }`, a child it
// renders) is native and paints each field's literal default; a Provider component in the page answers its children
// (a field the value leaves out is undefined, as in React). A nested-object default and a Provider written inline in the
// page (F446) fall back by name and render with React. Every page's markup, read in the browser, equals React's.
// Run alone: `bun test --timeout 120000 tests/server/ctx-object-defaults.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderReact } from '../../packages/brust/test/fixtures/ctx-object-defaults/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/ctx-object-defaults')
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

/** Every `data-testid` element's text, in document order. */
const marks = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => `${(e as HTMLElement).dataset.testid}=${e.textContent}`))

const pages: Array<[path: string, native: boolean]> = [
  ['/field', true],
  ['/destructure', true],
  ['/override', true],
  ['/nested', false],
  ['/inline', false],
]

for (const [path, native] of pages) {
  test(`${path}: ${native ? 'native' : 'a named fallback'}, the page equals React's`, async () => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    if (native) expect(html).not.toContain('brust-island')
    else expect(html).toContain('brust-island')
    const react = await browser.newPage()
    await react.setContent(`<!doctype html><html><body>${renderReact(path)}</body></html>`)
    const want = await marks(react)
    await react.close()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    expect(await marks(page)).toEqual(want)
    if (path === '/destructure') {
      // the page stays interactive, and the defaults stay painted after an update
      await page.getByTestId('inc').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="inc"]')?.textContent === '1')
      expect(await marks(page)).toEqual(want.map((m) => (m === 'inc=0' ? 'inc=1' : m)))
    }
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
}

test('the values React paints are the ones expected (defaults outside, the Provider value inside)', () => {
  expect(renderReact('/override')).toContain('<p data-testid="outside">dflt-2</p><p data-testid="mine">mine-3</p><p data-testid="only">only-undefined</p>')
  expect(renderReact('/inline')).toContain('<p data-testid="outside">x</p><p data-testid="inside">y</p>')
})
