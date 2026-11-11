// F517 R1.5 in real Chromium: an app module listed in `[build] expose` is ONE instance in the page. The built component's
// chunk bumps a module-level counter in `shop/sdk.ts`; the exposed entry URL (what a runtime component imports) reads the
// same counter, both through a dynamic import and through a second `<script type="module">`, and the module body ran once.
// Run alone: `bun test --timeout 120000 tests/server/expose.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/expose')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let sdkUrl = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  sdkUrl = `/_brust/${manifest.runtime.exposed['shop/sdk.ts']}`
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

test('the exposed entry is served as an immutable file', async () => {
  const r = await fetch(`${base}${sdkUrl}`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('javascript')
  expect(r.headers.get('cache-control')).toContain('immutable')
})

test('a built component and the exposed entry URL share one module instance (a counter bumped by one is read by the other)', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  // Mounted: the component's own click handler runs `bump()` from the exposed module.
  await page.click('[data-testid="b"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="b"]')!.textContent!.includes('native 1'))
  // (1) a dynamic import of the entry URL sees the bump.
  expect(await page.evaluate(async (u) => (await import(/* @vite-ignore */ u)).count, sdkUrl)).toBe(1)
  // (2) a second module script importing the entry URL sees it too.
  await page.addScriptTag({ type: 'module', content: `import { count } from ${JSON.stringify(sdkUrl)}; window.__seen = count` })
  await page.waitForFunction(() => (window as unknown as { __seen?: number }).__seen !== undefined)
  expect(await page.evaluate(() => (window as unknown as { __seen: number }).__seen)).toBe(1)
  // The module body ran once in the page, and the entry's exports are the source names.
  expect(await page.evaluate(() => (globalThis as unknown as { __shopSdkLoads: number }).__shopSdkLoads)).toBe(1)
  expect(await page.evaluate(async (u) => Object.keys(await import(/* @vite-ignore */ u)).sort(), sdkUrl)).toEqual(['bump', 'cart', 'count', 'default', 'instance'])
  expect(errors).toEqual([])
  await page.close()
})

test('the store defined in the exposed module is the component\'s store (one registry entry by name)', async () => {
  const page = await browser.newPage()
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.click('[data-testid="b"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="b"]')!.textContent!.includes('native 1'))
  // The component's handler set `cart.count`; the exposed module's own `cart` reads it back.
  expect(await page.evaluate(async (u) => (await import(/* @vite-ignore */ u)).cart.count(), sdkUrl)).toBe(1)
  await page.close()
})
