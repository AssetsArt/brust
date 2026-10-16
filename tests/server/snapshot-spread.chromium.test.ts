// F295 in real Chromium, against React hydrating the same page in the same browser. A never-written ref seeded from a
// live prop (Radix's BubbleInput `defaultChecked`) reaches the element through a forwarding primitive's spread: where
// every instance mounts with the page and never again (directly, and through a wrapper), it is printed once and stays
// the first render's value, as in React. Under a condition a later mount takes the value current then (F300): the
// child binds the snapshot on the forwarded element at mount, so that page is native too and equals React.
// Run alone: `bun test --timeout 120000 tests/server/snapshot-spread.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/snapshot-spread/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/snapshot-spread')
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

type Tiers = Record<string, { tier: string }>
const tiers = (): Tiers => (JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Tiers }).components
const tierOf = (prefix: string) => Object.entries(tiers()).find(([k]) => k.startsWith(prefix))![1].tier

/** `defaultChecked` and `checked` of every hidden input, by test id. */
const inputs = (page: Page) =>
  page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input[data-testid]')].map((i) => [i.dataset.testid, [i.defaultChecked, i.checked]])))

/** Opens `path` served by brust, or the same page hydrated by React, and runs `steps` (button test ids), recording the inputs after each. */
async function run(which: 'brust' | 'react', page: 'page' | 'guarded', steps: string[]): Promise<{ log: unknown[]; errors: string[] }> {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  if (which === 'react') {
    await p.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root">${renderPage(page)}</div><script>window.__page = ${JSON.stringify(page)}</script><script src="/app.js"></script></body></html>` }),
    )
    await p.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  } else {
    await p.goto(`${base}${page === 'page' ? '/' : '/guarded'}`, { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => document.querySelector('[data-testid="toggle"]')?.closest('[x-data], [data-brust-island], brust-island') !== null || document.querySelector('[data-hydrated]') !== null)
  }
  await p.waitForTimeout(200)
  const log: unknown[] = [await inputs(p)]
  for (const id of steps) {
    const before = await p.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)!.textContent, id)
    await p.locator(`[data-testid="${id}"]`).click()
    await p.waitForFunction(([t, b]) => document.querySelector(`[data-testid="${t}"]`)!.textContent !== b, [id, before])
    await p.waitForTimeout(50)
    log.push(await inputs(p))
  }
  await p.close()
  return { log, errors }
}

test('where every instance mounts once, the snapshot crosses the spread: native, and equal to React after changes', async () => {
  expect(tierOf('page_')).toBe('native')
  expect(tierOf('bubble_')).toBe('native')
  const html = await (await fetch(`${base}/`)).text()
  const firstPaint = (h: string) => [...h.matchAll(/<input[^>]*data-testid="([a-z]+)"[^>]*>/g)].map((m) => [m[1], /\schecked(?=[\s=>]|$)/.test(m[0])])
  expect(firstPaint(html)).toEqual(firstPaint(renderPage('page')))
  const steps = ['toggle', 'toggle', 'toggle']
  const react = await run('react', 'page', steps)
  const served = await run('brust', 'page', steps)
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  // React keeps the first render's value: `on` was true.
  expect(react.log.at(-1)).toEqual({ always: [true, true], mid: [true, true] })
  expect(served.log).toEqual(react.log)
}, 90_000)

test('under a condition a later mount takes the value current then: native, and equal to React', async () => {
  expect(tierOf('guarded_')).toBe('native')
  expect(tierOf('bubble_')).toBe('native')
  const steps = ['toggle', 'open', 'open', 'toggle', 'open']
  const react = await run('react', 'guarded', steps)
  const served = await run('brust', 'guarded', steps)
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  // React: the first open mounts with on=false, the reopen after the second toggle with on=true.
  expect(react.log[2]).toEqual({ late: [false, false] })
  expect(react.log.at(-1)).toEqual({ late: [true, true] })
  expect(served.log).toEqual(react.log)
}, 90_000)
