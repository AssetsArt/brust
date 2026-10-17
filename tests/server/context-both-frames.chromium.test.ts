// F317 in real Chromium, against React hydrating the same page: a Provider of K in the page AND Root's own Provider of K around
// the Thumb that the page passes through Root's rest. React reads the Thumb against Root's inner Provider and the Outer reader
// against the page's. Served output must equal React's at first paint and after each change (the inner flip, the outer flip).
// Run alone: `bun test --timeout 120000 tests/server/context-both-frames.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/context-both-frames/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/context-both-frames')
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

/** What a viewer can observe: the Thumb (inner frame), the Outer reader (page frame), and that the Thumb sits in Root's label. */
const observe = (page: Page) =>
  page.evaluate(() => {
    const state = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-state') ?? null
    const root = document.querySelector('[data-testid="root"]')
    const thumb = document.querySelector('[data-testid="thumb"]')
    return { thumb: state('thumb'), outer: state('outer-reader'), inLabel: !!root?.contains(thumb) }
  })

async function run(open: (page: Page) => Promise<void>): Promise<{ log: unknown[]; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await open(page)
  await page.waitForTimeout(200)
  const log: unknown[] = [await observe(page)]
  // inner flip, outer flip, inner flip, outer flip: each moves only its own frame
  for (const [button, key, want] of [
    ['flip', 'thumb', 'checked'],
    ['outer-flip', 'outer', 'unchecked'],
    ['flip', 'thumb', 'unchecked'],
    ['outer-flip', 'outer', 'checked'],
  ] as const) {
    await page.locator(`[data-testid="${button}"]`).click()
    const id = key === 'thumb' ? 'thumb' : 'outer-reader'
    await page.waitForFunction(([t, w]) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute('data-state') === w, [id, want])
    log.push(await observe(page))
  }
  await page.close()
  return { log, errors }
}

test('the page is compiled natively: no component is on the React tier', () => {
  // Without this the match below could be React serving itself (a relative `K.Provider` member tag is a React page).
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  expect(Object.keys(manifest.components).length).toBeGreaterThan(0)
  expect(Object.values(manifest.components).every((c) => c.tier !== 'react')).toBe(true)
})

test("first paint equals React's render", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const state = (h: string, id: string) => new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(h)?.[0].match(/data-state="([a-z]+)"/)?.[1]
  // the inner frame says unchecked, the page's frame says checked
  expect(state(renderPage(), 'thumb')).toBe('unchecked')
  expect(state(renderPage(), 'outer-reader')).toBe('checked')
  expect(state(html, 'thumb')).toBe(state(renderPage(), 'thumb'))
  expect(state(html, 'outer-reader')).toBe(state(renderPage(), 'outer-reader'))
})

test('after the inner and outer flips, every observable value equals React hydrating the same page', async () => {
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
    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  })
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  expect(react.log.at(-1)).toEqual({ thumb: 'unchecked', outer: 'checked', inLabel: true })
  expect(served.log).toEqual(react.log)
}, 90_000)
