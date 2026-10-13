// L22 in real Chromium: a component from a package in a static and in a native parent is server-rendered and
// hydrates as a React island with no console error (React reports a mismatch as pageerror/console.error);
// the native parent stays interactive. The package is a tiny local one (no network). Run alone:
// `bun test --timeout 120000 tests/server/external-island.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { installTinyIcons } from '../../packages/brust/test/fixtures/ext-island/install'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/ext-island')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let uninstall: () => void

beforeAll(async () => {
  uninstall = installTinyIcons(app)
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
  uninstall?.()
})

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
  return { page, errors }
}

test('static parent: the package island is server-rendered and hydrates without a mismatch', async () => {
  const { page, errors } = await open('/')
  expect(await page.locator('brust-island svg[data-icon="heart"]').getAttribute('width')).toBe('16')
  expect(await page.locator('brust-island title').textContent()).toBe('loved')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('native parent: the package island hydrates and the native button stays interactive', async () => {
  const { page, errors } = await open('/native')
  expect(await page.locator('brust-island svg[data-icon="heart"]').getAttribute('width')).toBe('20')
  await page.getByRole('button').click()
  await page.waitForFunction(() => document.querySelector('button')?.textContent?.trim() === '1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
