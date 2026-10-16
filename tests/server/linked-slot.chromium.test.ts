// F309 in real Chromium, against React hydrating the same page in the same browser: a static child the page links
// (`<Label on={on}>`) printed slot content with a linked prop of the page (`<Thumb on={on}/>`) inside a host of its own,
// which bound it (the runtime binds by the nearest x-data), so the Thumb never updated. It was then refused (slot-owner);
// F307 now clones the Label for this call site with the Thumb inside, so the page is native: every observable value
// equals React after each click.
// Run alone: `bun test --timeout 120000 tests/server/linked-slot.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/linked-slot/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/linked-slot')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let reactJs = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
  if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
  reactJs = await r.outputs[0]!.text()
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

const observe = (page: Page) =>
  page.evaluate(() => ({
    label: document.querySelector('[data-testid="label"]')?.getAttribute('data-on') ?? null,
    thumb: document.querySelector('[data-testid="thumb"]')?.getAttribute('data-state') ?? null,
  }))

async function run(open: (page: Page) => Promise<void>): Promise<{ log: unknown[]; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  await open(page)
  await page.waitForTimeout(200)
  const log: unknown[] = [await observe(page)]
  for (const want of ['yes', 'no', 'yes']) {
    await page.locator('[data-testid="flip"]').click()
    await page.waitForFunction((w) => document.querySelector('[data-testid="label"]')?.getAttribute('data-on') === w, want)
    await page.waitForTimeout(50)
    log.push(await observe(page))
  }
  await page.close()
  return { log, errors }
}

test('the page is native: the linked Label is cloned with its slot content (F307)', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  expect(Object.entries(manifest.components).find(([k]) => k.startsWith('page_'))![1].tier).toBe('native')
})

test('after each click, every observable value equals React hydrating the same page', async () => {
  const react = await run(async (page) => {
    await page.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root">${renderPage()}</div><script src="/app.js"></script></body></html>` }),
    )
    await page.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  })
  const served = await run(async (page) => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[x-data], [data-hydrated], brust-island') !== null)
  })
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  expect(react.log.at(-1)).toEqual({ label: 'yes', thumb: 'checked' })
  expect(served.log).toEqual(react.log)
}, 90_000)
