// F562 in real Chromium: a list whose `.map` callback destructures its item and has a block body (a row const read by the
// markup and by a click handler, an early `return null`) is native: the served HTML equals React's renderToString, a click
// acts on the row it is on (after a reorder too), and a state change re-renders the rows, the early return included.
// Run alone: `bun test --timeout 120000 tests/server/list-shapes.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { firstDifference, normalise } from '../../scripts/battery/ssr-normalise.ts'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/list-shapes')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
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

/** The page's `<div>…</div>` root (the served document wraps it; React's render is it). */
const root = (html: string): string => {
  const at = html.indexOf('<div')
  const end = html.lastIndexOf('</div>')
  if (at < 0 || end < 0) throw new Error(`no root in ${html}`)
  return html.slice(at, end + '</div>'.length)
}

test('the served HTML equals React and the page is native', async () => {
  const served = await (await fetch(base)).text()
  expect(served).toContain('x-for=')                  // a native list, not a React island
  expect(served).not.toContain('<brust-island')
  const script = join(app, '.react-render.tsx')
  writeFileSync(script, `import { renderToString } from 'react-dom/server'\nimport Rows from './Rows'\nprocess.stdout.write(renderToString(<Rows />))\n`)
  const r = Bun.spawnSync([process.execPath, script], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  const diff = firstDifference(normalise(root(served)), normalise(r.stdout.toString()))
  expect(diff).toBeNull()
}, 60_000)

test('a click acts on its row, after a reorder too, and a state change re-renders the rows', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(base, { waitUntil: 'load' })
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  const rows = () => page.locator('[data-testid="rows"] li:not([hidden])').allTextContents()
  const picked = () => page.getByTestId('picked').textContent()
  expect(await rows()).toEqual(['Alpha (3)', 'Beta (10)', 'Gamma (7)'])
  await page.getByTestId('row-b').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="picked"]')?.textContent !== 'none')
  expect(await picked()).toBe('Beta (10) #1')
  await page.getByTestId('reverse').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="rows"] li:not([hidden])')?.textContent === 'Gamma (7)')
  expect(await rows()).toEqual(['Gamma (7)', 'Beta (10)', 'Alpha (3)'])
  await page.getByTestId('row-a').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="picked"]')?.textContent === 'Alpha (3) #2')
  await page.getByTestId('bump').click()                     // Beta goes over 12: its early return hides it
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rows"] li:not([hidden])').length === 2)
  expect(await rows()).toEqual(['Gamma (12)', 'Alpha (8)'])
  expect(await page.getByTestId('row-c').getAttribute('title')).toBe('Gamma (12)')
  await page.getByTestId('row-c').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="picked"]')?.textContent === 'Gamma (12) #0')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
