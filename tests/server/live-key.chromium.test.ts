// F308 in real Chromium: a `key` that changes on an element outside a list makes React remount it (its state resets). brust
// keeps the instance, so the page is a named refusal (`key-outside-list`) and renders with React: served 200, the markup
// is React's, and swapping the key resets the counter as React does.
// Run alone: `bun test --timeout 120000 tests/server/live-key.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/live-key')
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

test('/key: a changing key remounts the counter (state resets), as in React', async () => {
  const res = await fetch(`${base}/key`)
  expect(res.status).toBe(200)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/key`, { waitUntil: 'networkidle' })
  const count = page.getByTestId('count')
  await count.click()
  await count.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '2')
  await page.getByTestId('swap').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '0')
  await count.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
