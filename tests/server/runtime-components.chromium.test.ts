// F519 R5.10 in real Chromium: a <Dynamic> slot in server list rows renders runtime components the routes entry resolves
// lazily (hand-written R2 artifacts in the fixture): a static one, a native one that mounts, reads a prop passed through
// <Dynamic props> and writes the exposed `cart` store a BUILT component reads, a missing ref and a throwing resolver (both
// print nothing, the page is a 200). Warm refs are not resolved again; SPA navigation away and back keeps it working.
// Run alone: `bun test --timeout 180000 tests/server/dynamic-slot.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/runtime-components')
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

const other = async () => {
  const html = await (await fetch(`${base}/other`)).text()
  return { calls: Number(/data-testid="calls">(\d+)</.exec(html)![1]), refusals: JSON.parse((/data-testid="refusals">([^<]*)</.exec(html)![1]).replaceAll('&quot;', '"')) as Record<string, string[]> }
}

test('the build exposes the store module the sources import', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  expect(m.runtime.stores).toEqual({ cart: 'shop/sdk.ts' })
  expect(Object.keys(m.runtime.exposed)).toEqual(['shop/sdk.ts'])
})

test('sources compiled inside the resolver render in the rows; a refused source and an unknown ref print nothing', async () => {
  const r = await fetch(`${base}/`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('<li data-ref="note"><b class="rc-note">Hello</b></li>')
  expect(html).toMatch(/<li data-ref="promo"><button [^>]*data-testid="rc-promo"[^>]*>/)
  expect(html).toContain('<li data-ref="bad"></li>')
  expect(html).toContain('<li data-ref="gone"></li>')
  expect(html).toMatch(new RegExp(`<script type="module" src="/_brust/rc/${build}/promo/[A-Za-z0-9_]+\\.js"></script>`))
  expect(html).toContain('<script type="application/json" data-brust-store="cart">')
  const first = await other()
  expect(first.refusals.bad).toContain('runtime-import')
  expect(Object.keys(first.refusals)).toEqual(['bad'])
  // `note`, `promo` and `bad` were compiled once each; a second page view compiles nothing (warm, or remembered as missing).
  expect(first.calls).toBe(3)
  await fetch(`${base}/`)
  expect((await other()).calls).toBe(3)
})

test('the compiled button changes the store a built component on the page reads; SPA navigation keeps it working', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  expect(await page.textContent('[data-testid="rc-promo"]')).toBe('Add 0')
  await page.click('[data-testid="rc-promo"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="badge"]')!.textContent === '1')
  expect(await page.textContent('[data-testid="rc-promo"]')).toBe('Add 1')
  await page.click('[data-testid="to-other"]')
  await page.waitForSelector('[data-testid="calls"]')
  await page.click('[data-testid="to-list"]')
  await page.waitForSelector('[data-testid="rc-promo"]')
  // The page came back through the SPA navigation: its hosts mount again and a click still moves the one store.
  const before = Number(await page.textContent('[data-testid="badge"]'))
  await page.click('[data-testid="rc-promo"]')
  await page.waitForFunction((n) => document.querySelector('[data-testid="badge"]')!.textContent === String(n + 1), before)
  expect(await page.textContent('[data-testid="rc-promo"]')).toBe(`Add ${before + 1}`)
  expect(errors).toEqual([])
  await page.close()
})
