// F297 in real Chromium, against React hydrating the same page in the same browser. Radix's Switch/Checkbox Provider
// computes `isFormControl = control ? !!form || !!control.closest('form') : true` with `control` a `useState(null)` set by
// a ref callback: the server takes the `true` arm (no precompute job), and the client recomputes it once the ref is set,
// so the hidden input stays inside a <form> (or with a `form` prop) and is dropped outside one. The hidden input's effect
// (state set by a ref callback, the native `checked` setter, then a bubbling click) is Radix's BubbleInput.
// Run alone: `bun test --timeout 120000 tests/server/form-control.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/form-control/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/form-control')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const IDS = ['in', 'out', 'named'] as const
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

/** Per control: the button's `data-form` and whether its hidden input is in the markup. */
const markup = (html: string) =>
  Object.fromEntries(IDS.map((id) => [id, { form: new RegExp(`data-testid="${id}-button"[^>]*data-form="([yn])"|data-form="([yn])"[^>]*data-testid="${id}-button"`).exec(html)?.slice(1).find(Boolean) ?? null, input: html.includes(`data-testid="${id}-input"`) }]))

/** Counts, per hidden input, the click events that reach the document (the form notification), from before any script runs. */
const COUNT = () => {
  const w = window as unknown as { __clicks: Record<string, number> }
  w.__clicks = {}
  document.addEventListener('click', (e) => {
    const id = (e.target as Element | null)?.getAttribute?.('data-testid')
    if (id?.endsWith('-input')) w.__clicks[id] = (w.__clicks[id] ?? 0) + 1
  }, true)
}

/** What a viewer of the page can observe, per control. */
const observe = (page: Page) =>
  page.evaluate((ids) => {
    const w = window as unknown as { __clicks: Record<string, number> }
    return Object.fromEntries(ids.map((id) => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${id}-input"]`)
      const button = document.querySelector(`[data-testid="${id}-button"]`)!
      return [id, { form: button.getAttribute('data-form'), text: button.textContent, input: input ? input.checked : null, clicks: w.__clicks[`${id}-input`] ?? 0 }]
    }))
  }, [...IDS])

/** Loads the page, lets the mount effects settle, then clicks every button twice, recording what is observable. */
async function run(open: (page: Page) => Promise<void>): Promise<{ log: unknown[]; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await page.addInitScript(COUNT)
  await open(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="out-button"]')?.getAttribute('data-form') === 'n')
  await page.waitForTimeout(200)
  const log: unknown[] = [await observe(page)]
  for (const id of IDS) {
    for (const want of ['on', 'off']) {
      await page.locator(`[data-testid="${id}-button"]`).click()
      await page.waitForFunction(([t, w]) => document.querySelector(`[data-testid="${t}-button"]`)?.textContent === w, [id, want])
      await page.waitForTimeout(50)
      log.push(await observe(page))
    }
  }
  await page.close()
  return { log, errors }
}

test("first paint equals React's render: the server takes the `true` arm, every hidden input is printed", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const react = markup(renderPage())
  expect(react).toEqual({ in: { form: 'y', input: true }, out: { form: 'y', input: true }, named: { form: 'y', input: true } })
  expect(markup(html)).toEqual(react)
  // No precompute job: the condition was decided at the server, the method call was never needed there.
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string; jobs: unknown[] }> }
  const control = Object.entries(manifest.components).find(([k]) => k.startsWith('control_'))![1]
  expect(control).toMatchObject({ tier: 'native', jobs: [] })
})

test('after hydration and clicks, every observable value equals React hydrating the same page', async () => {
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
  })
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  // React: outside a form (and with no `form` prop) the hidden input is dropped once the ref callback sets `control`.
  expect((react.log[0] as Record<string, { form: string; input: boolean | null }>).out).toMatchObject({ form: 'n', input: null })
  expect(served.log).toEqual(react.log)
}, 90_000)
