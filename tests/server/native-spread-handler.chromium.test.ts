// F369c in real Chromium: a handler a caller passes to a NATIVE child that spreads its props lands on the child's element, which
// binds it itself (`x-prop-on-mousedown`): served 200, no React island for the child, the handler runs on a mousedown, the
// child's own click still toggles its state, and a prop that changes is the one that runs (read at event time).
// Run alone: `bun test --timeout 120000 tests/server/native-spread-handler.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/native-spread-handler')
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

test('a mousedown handler reaches the native child element, and the swapped prop is the one that runs', async () => {
  const res = await fetch(`${base}/`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('x-prop-on-mousedown="onMouseDown"')
  expect(html).toContain('x-prop-on-input="onChange"')
  expect(html).not.toContain('brust-island')
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  const pr = page.getByTestId('pr')
  await pr.dispatchEvent('mousedown')
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '1')
  await pr.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="pr"]')?.getAttribute('aria-pressed') === 'true')
  await page.getByTestId('swap').click()
  await pr.dispatchEvent('mousedown')
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '102')
  // Mellow F1: React's onChange on a text field is the DOM `input` event; typing must reach the handler.
  await page.getByTestId('field').fill('hello')
  await page.waitForFunction(() => document.querySelector('[data-testid="typed"]')?.textContent === 'hello')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
