// L23 in real Chromium: a lucide icon in a native component is inline SVG (no React, no island) whose
// size and color follow state. Run alone: `bun test --timeout 120000 tests/server/lucide.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/lucide')
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

test('a native lucide icon follows state: size and color update, no island, no console error', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/native`, { waitUntil: 'load' })
  const svg = page.locator('svg.lucide-heart')
  expect(await svg.getAttribute('width')).toBe('16')
  expect(await svg.getAttribute('stroke')).toBe('red')
  expect(await page.locator('brust-island').count()).toBe(0)
  await page.waitForTimeout(300)   // let the client chunk mount
  await page.locator('#grow').click()
  await page.waitForFunction(() => document.querySelector('svg.lucide-heart')?.getAttribute('width') === '24')
  expect(await svg.getAttribute('height')).toBe('24')
  await page.locator('#paint').click()
  await page.waitForFunction(() => document.querySelector('svg.lucide-heart')?.getAttribute('stroke') === 'blue')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('an undefined state size renders the default and follows the state', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/native-undefined`, { waitUntil: 'load' })
  const svg = page.locator('svg.lucide-heart')
  expect(await svg.getAttribute('width')).toBe('24')   // React's default, not a missing attribute
  await page.waitForTimeout(300)
  await page.locator('#set').click()
  await page.waitForFunction(() => document.querySelector('svg.lucide-heart')?.getAttribute('width') === '8')
  await page.locator('#unset').click()
  await page.waitForFunction(() => document.querySelector('svg.lucide-heart')?.getAttribute('width') === '24')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('static page icons are SVG elements with no script for them', async () => {
  const page = await browser.newPage()
  await page.goto(`${base}/`, { waitUntil: 'load' })
  expect(await page.locator('svg.lucide-heart').count()).toBe(2)   // one literal, one with dynamic props
  expect(await page.locator('svg.lucide-star path[vector-effect="non-scaling-stroke"]').count()).toBe(1)
  expect(await page.locator('script[type="module"]').count()).toBe(0)
  await page.close()
}, 60_000)
