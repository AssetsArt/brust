// F195 + F196 in real Chromium: a native component whose attributes are `aria-*`, `data-*`, `draggable`, `spellCheck`
// (React writes the booleans as strings), `hidden`/`download` (boolean / overloaded), and `title` (React omits a boolean),
// and whose click handler calls React's SyntheticEvent members. First paint equals React's own render; after a click the
// attributes equal React's render of the opposite state; the handler throws nothing and stops the click reaching the parent.
// Run alone: `bun test --timeout 120000 tests/server/event-aria.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderGizmo } from '../../packages/brust/test/fixtures/event-aria/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/event-aria')
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

/** The `<button …>` attributes of a page's markup, sorted, as `name="value"`. */
const buttonAttrs = (html: string): string[] => {
  const tag = /<button([^>]*)>/.exec(html)![1]!
  return [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
    .map((m) => `${m[1]!.toLowerCase()}="${m[2] ?? ''}"`)
    .filter((a) => !a.startsWith('x-') && !a.startsWith('data-testid'))
    .sort()
}

/** The same attributes read from the live DOM (what a user sees after hydration and a click). */
const domAttrs = (names: string[]): string[] => {
  const el = document.querySelector('[data-testid="btn"]')!
  return names.filter((n) => el.hasAttribute(n)).map((n) => `${n}="${el.getAttribute(n)}"`).sort()
}

test('first paint equals React\'s own render of the same source', async () => {
  const served = buttonAttrs(await (await fetch(`${base}/`)).text())
  const react = buttonAttrs(renderGizmo(true))
  expect(react).toContain('aria-pressed="true"')
  expect(served).toEqual(react)
})

test('after a click the attributes equal React\'s render of the opposite state, and the handler\'s synthetic-event calls work', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  const react = buttonAttrs(renderGizmo(false))
  // React omits `title={false}`, `download={false}` and `hidden={false}`; it writes the other three as "false".
  expect(react).toContain('aria-pressed="false"')
  expect(react).toContain('data-on="false"')
  expect(react).toContain('draggable="false"')
  const names = ['aria-pressed', 'data-on', 'draggable', 'spellcheck', 'hidden', 'download', 'title']
  await page.waitForFunction(() => document.querySelector('[data-testid="btn"]')?.getAttribute('aria-pressed') === 'true')
  await page.getByTestId('btn').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="btn"]')?.getAttribute('aria-pressed') === 'false')
  const want = react.filter((a) => names.includes(a.split('=')[0]!))
  expect(await page.evaluate(domAttrs, names)).toEqual(want)
  // the handler stopped the click: the parent's onClick did not run
  expect(await page.getByTestId('outer').getAttribute('data-outer')).toBe('0')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
