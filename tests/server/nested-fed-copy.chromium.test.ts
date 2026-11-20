// F560 in a browser: a native child with a job of its own inside a component that has one too is its React copy THERE (an
// island). The copy hydrates and answers a click, the same child placed in the page itself is bound by the runtime and
// answers a click too, and neither changes the other.
// Run alone: `bun test --timeout 120000 tests/server/nested-fed-copy.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/nested-fed')
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

test('the React copy hydrates and toggles; the native child of the page toggles on its own', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/shell`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })

  const copy = page.locator('brust-island button.tone-WARN')
  const direct = page.locator('button.tone-DIRECT')
  expect(await copy.count()).toBe(1)
  expect(await direct.count()).toBe(1)
  // The page's own Bell is outside every island.
  expect(await page.locator('brust-island button.tone-DIRECT').count()).toBe(0)
  expect(await copy.textContent()).toBe('off')
  expect(await direct.textContent()).toBe('off')

  await copy.click()
  await page.waitForFunction(() => document.querySelector('brust-island button.tone-WARN')?.textContent === 'on', undefined, { timeout: 5000 })
  expect(await direct.textContent()).toBe('off')

  await direct.click()
  await page.waitForFunction(() => document.querySelector('button.tone-DIRECT')?.textContent === 'on', undefined, { timeout: 5000 })
  expect(await copy.textContent()).toBe('on')
  // The component around the copy is server markup with its own computed class, untouched by the island.
  expect(await page.locator('header.tone-TOP > b').textContent()).toBe('top')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
