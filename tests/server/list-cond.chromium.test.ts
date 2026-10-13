// L6 R6.1 in real Chromium: a list whose `.map` returns `it.link && <li key={it.link.id}>` mixes null-link and
// linked rows. The guarded key must not throw, rows must render, reorder and toggle. Run alone:
// `bun test --timeout 120000 tests/server/list-cond.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/list-cond')
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

test('mixed null-link and linked rows render, reorder and toggle without a console error', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(base, { waitUntil: 'load' })
  const rows = () => page.locator('li:not([hidden]) a').allTextContents()
  expect(await rows()).toEqual(['Beta'])                      // server paint: only the linked row
  await page.waitForTimeout(300)                                // let the client chunk mount
  expect(await rows()).toEqual(['Beta'])
  await page.getByTestId('toggle').click()                    // Alpha gains a link
  await page.waitForFunction(() => document.querySelectorAll('li:not([hidden]) a').length === 2)
  expect(await rows()).toEqual(['Alpha', 'Beta'])
  await page.getByTestId('reorder').click()                   // [c, b, a] reversed order
  await page.waitForFunction(() => document.querySelector('li:not([hidden]) a')?.textContent === 'Beta')
  expect(await rows()).toEqual(['Beta', 'Alpha'])
  await page.getByTestId('toggle').click()                    // Alpha loses its link again
  await page.waitForFunction(() => document.querySelectorAll('li:not([hidden]) a').length === 1)
  expect(await rows()).toEqual(['Beta'])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
