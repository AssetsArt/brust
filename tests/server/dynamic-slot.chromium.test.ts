// F519 R5.10 in real Chromium: a <Dynamic> slot in server list rows renders runtime components the routes entry resolves
// lazily (hand-written R2 artifacts in the fixture): a static one, a native one that mounts, reads a prop passed through
// <Dynamic props> and writes the exposed `cart` store a BUILT component reads, a missing ref and a throwing resolver (both
// print nothing, the page is a 200). Warm refs are not resolved again; SPA navigation away and back keeps it working.
// Run alone: `bun test --timeout 180000 tests/server/dynamic-slot.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/dynamic-slot')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let build = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  build = manifest.assets.build
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
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const calls = async () => Number(/data-testid="calls">(\d+)</.exec(await (await fetch(`${base}/other`)).text())![1])

test('the manifest marks the page that holds a slot', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const dyn = Object.entries(m.components as Record<string, { dynamic?: boolean }>).filter(([, c]) => c.dynamic)
  expect(dyn.length).toBe(1)
  expect(m.runtime.stores).toEqual({ cart: 'shop/sdk.ts' })
})

test('rows render each slot: static, native, missing and throwing (a 200 either way); warm refs are not resolved again', async () => {
  const r = await fetch(`${base}/`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('<li data-ref="hello"><b class="rc-hello">Hi</b></li>')
  expect(html).toMatch(/<li data-ref="counter"><button type="button" x-data="rc_counter_v1"[^>]*>Add <span x-text="_c1">0<\/span><\/button><\/li>/)
  expect(html).toContain('<li data-ref="gone"></li>')
  expect(html).toContain('<li data-ref="boom"></li>')
  expect(html).toContain(`<script type="module" src="/_brust/rc/${build}/counter/rc_counter_v1.js"></script>`)
  expect(html).toContain('<script type="application/json" data-brust-store="cart">')
  const first = await calls()
  expect(first).toBe(4)
  await fetch(`${base}/`)
  // `hello` and `counter` are warm, `gone` is remembered as missing; only the throwing ref is asked again.
  expect(await calls()).toBe(first + 1)
})

test('the chunk route serves the artifact by id only', async () => {
  const ok = await fetch(`${base}/_brust/rc/${build}/counter/rc_counter_v1.js`)
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toContain('javascript')
  expect(ok.headers.get('cache-control')).toContain('immutable')
  expect(await ok.text()).toContain('defineBehavior("rc_counter_v1"')
  const wrong = await fetch(`${base}/_brust/rc/${build}/counter/rc_counter_v0.js`)
  expect(wrong.status).toBe(404)
  expect(wrong.headers.get('cache-control')).toBe('no-store')
  expect((await fetch(`${base}/_brust/rc/${build}/hello/rc_hello_v1.js`)).status).toBe(404)
})

test('the native artifact mounts, reads its prop and writes the store a built component reads; SPA navigation keeps it', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.evaluate(() => ((globalThis as unknown as { __marker?: number }).__marker = 1)) // survives an SPA navigation, not a document load
  await page.click('[data-testid="rc-counter"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="badge"]')!.textContent === '1')
  expect(await page.textContent('[data-testid="rc-counter"]')).toBe('Add 1')
  expect(await page.evaluate(() => (globalThis as unknown as { __rcLabel?: string }).__rcLabel)).toBe('Add')
  // Away and back through the SPA navigation: the slot's page comes back and its component mounts again.
  await page.click('[data-testid="to-other"]')
  await page.waitForSelector('[data-testid="calls"]')
  await page.click('[data-testid="to-list"]')
  await page.waitForSelector('[data-testid="rc-counter"]')
  // A real SPA navigation (the window marker survived) and a live store never re-reads its seed: the count is still 1.
  expect(await page.evaluate(() => (globalThis as unknown as { __marker?: number }).__marker)).toBe(1)
  expect(await page.textContent('[data-testid="badge"]')).toBe('1')
  expect(await page.textContent('[data-testid="rc-counter"]')).toBe('Add 1')
  await page.click('[data-testid="rc-counter"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="badge"]')!.textContent === '2')
  expect(await page.textContent('[data-testid="rc-counter"]')).toBe('Add 2')
  expect(errors).toEqual([])
  await page.close()
})

test('--target static refuses a build with a <Dynamic> slot (dynamic-target)', () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static', '--out-dir', '.static-out'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  rmSync(join(app, '.static-out'), { recursive: true, force: true })
  expect(b.exitCode).not.toBe(0)
  expect(b.stderr.toString()).toContain('dynamic-target')
})
