// F153c (plan 2026-10-14-shadcn-package-leaf, R34.61/R34.62/R34.65/R34.68) in real Chromium: shadcn's Label renders
// Radix `Label.Root`, which the build now compiles from `@radix-ui/react-label`'s own source (its source map), with
// `Primitive.label` as the host <label>. The page ships no React island and no Radix code: only the Label's native
// chunk (its double-click selection guard). The served HTML is React's, apart from the native host wrapper and the
// `x-*` attributes, and the behaviour is Radix's: a click focuses the input, a double click selects no text, and a
// press inside an inner button is left alone. Run alone:
// `bun test --timeout 180000 tests/server/package-source.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../fixtures/shadcn')
const dist = '.rows/dist-package-source'
const entry = 'package-source/routes.tsx'
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', entry, '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist, '--entry', entry], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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
  rmSync(join(app, dist), { recursive: true, force: true })
})

/** React's server render of a fixture page, from the fixture (its own react / react-dom / radix-ui). */
function react(file: string): string {
  const code = `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import Page from './${file}'; process.stdout.write(renderToStaticMarkup(createElement(Page)))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}

test('the label is compiled: no island, no Radix or React in the client', () => {
  const m = JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries(m.components).map(([id, c]: [string, any]) => [id.replace(/_[0-9a-f]+$/, ''), c.tier]))
  // The page, shadcn's Label and Input, Radix's Label.Root (`Root`, native) and `Primitive.label`.
  expect(tiers).toEqual({ page: 'static', label: 'static', input: 'static', root: 'native', primitive: 'static' })
  const client = readdirSync(join(app, dist, 'client')).filter((f) => f.endsWith('.js'))
  expect(client.some((f) => /^island|react/.test(f))).toBe(false)
  for (const f of client) expect(readFileSync(join(app, dist, 'client', f), 'utf8')).not.toMatch(/radix|createSlot|forwardRef/)
})

test("the served HTML is React's, apart from the native host and its x-* attributes", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const start = html.indexOf('<div class="grid')
  const end = html.lastIndexOf('</div>') + '</div>'.length
  const ours = html
    .slice(start, end)
    .replace(/<brust-host[^>]*>|<\/brust-host>/g, '')
    .replace(/ x-[a-z-]+="[^"]*"| x-props='[^']*'/g, '')
  // React serialises a void element as `<input …/>`, the template as `<input …>`: the same HTML.
  expect(ours).toBe(react('package-source/page.tsx').replace(/<(input|img|br|hr)([^>]*)\/>/g, '<$1$2>'))
  expect(html).not.toContain('<brust-island')
})

test("Radix's behaviour: a click focuses the input, a double click selects nothing, an inner button is left alone", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.getByTestId('label').click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'input')
  // A double click on label text would select a word; Radix prevents the mousedown default when detail > 1.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.getByTestId('label').dblclick()
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  // The guard returns early inside a button: its mousedown is not prevented (it takes focus as usual).
  const prevented = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="inner"]')!
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 })
    b.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  expect(prevented).toBe(false)
  const onLabel = await page.evaluate(() => {
    const l = document.querySelector('[data-testid="with-button"]')!
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 })
    l.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  expect(onLabel).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
