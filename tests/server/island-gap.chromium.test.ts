// F413 (Assets Art B-11) in real Chromium: a React island between two flex items of a `gap:24px` row is a
// `display:contents` wrapper, so a hidden island adds no gap (a and b are 24 px apart, as in the inlined React layout)
// and a shown one still hydrates and keeps its state. Run alone: `bun test --timeout 120000 tests/server/island-gap.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/island-gap')
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
  await page.waitForFunction(() => document.querySelector('brust-island[data-hydrated="1"]') !== null, null, { timeout: 15_000 })
  return { page, errors }
}

test('the island host takes no box: a hidden island adds no flex gap', async () => {
  const { page, errors } = await open('/hidden')
  expect(await page.locator('brust-island').getAttribute('style')).toBe('display:contents')
  const gap = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="a"]')!.getBoundingClientRect()
    const b = document.querySelector('[data-testid="b"]')!.getBoundingClientRect()
    return b.left - a.right
  })
  expect(gap).toBe(24)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a shown island still hydrates and keeps its own state', async () => {
  const { page, errors } = await open('/shown')
  const gate = page.getByTestId('gate')
  expect(await gate.textContent()).toBe('gate 0')
  await gate.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="gate"]')?.textContent === 'gate 1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
