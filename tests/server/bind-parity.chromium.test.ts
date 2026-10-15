// F201 + F202 in real Chromium: attributes that the runtime's x-bind-* updates after a click (every React boolean
// attribute, aria-*/data-*, download, and an SVG <a> href that becomes "") equal React's own render of that state.
// Run alone: `bun test --timeout 120000 tests/server/bind-parity.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderProbe } from '../../packages/brust/test/fixtures/bind-parity/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/bind-parity')
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


const NAMES = ['loop', 'muted', 'inert', 'itemscope', 'allowfullscreen', 'autoplay', 'playsinline', 'novalidate', 'readonly', 'required', 'reversed', 'aria-busy', 'data-on', 'download']

const CE = ['disabled', 'aria-busy', 'foo', 'download']

/** `name="value"` pairs of one tag's attributes from React's markup, sorted. */
const reactAttrs = (html: string, testid: string, names: string[]): string[] => {
  const tag = new RegExp(`<[a-z-]+[^>]*data-testid="${testid}"[^>]*>`).exec(html)![0]
  return [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
    .map((m) => `${m[1]!.toLowerCase()}="${m[2] ?? ''}"`)
    .filter((a) => names.includes(a.split('=')[0]!))
    .sort()
}

/** The same attributes of the live element. */
const domAttrs = ([testid, names]: [string, string[]]): string[] => {
  const el = document.querySelector(`[data-testid="${testid}"]`)!
  return names.filter((n) => el.hasAttribute(n)).map((n) => `${n}="${el.getAttribute(n)}"`).sort()
}

test('first paint equals React for the boolean attributes and the SVG <a>', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const react = renderProbe(true)
  expect(reactAttrs(react, 'bools', NAMES)).toContain('loop=""')
  expect(reactAttrs(html, 'bools', NAMES)).toEqual(reactAttrs(react, 'bools', NAMES))
  expect(reactAttrs(html, 'svga', ['href'])).toEqual(['href="/x"'])
  expect(reactAttrs(html, 'ce', CE)).toEqual(reactAttrs(react, 'ce', CE))
  expect(reactAttrs(react, 'ce', CE)).toContain('aria-busy=""')
})

test('after each click the client-updated attributes equal React\'s render of that state', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="bools"]')?.hasAttribute('loop'))
  for (const state of [false, true, false]) {
    await page.getByTestId('flip').click()
    await page.waitForFunction((s) => document.querySelector('[data-testid="bools"]')?.hasAttribute('loop') === s, state)
    const react = renderProbe(state)
    expect(await page.evaluate(domAttrs, ['bools', NAMES] as [string, string[]])).toEqual(reactAttrs(react, 'bools', NAMES))
    // a custom element (F213): React passes every attribute through, true is "", false omits it
    expect(await page.evaluate(domAttrs, ['ce', CE] as [string, string[]])).toEqual(reactAttrs(react, 'ce', CE))
    // the SVG <a>: React keeps href="" on an anchor, SVG included
    expect(await page.evaluate(domAttrs, ['svga', ['href']] as [string, string[]])).toEqual(reactAttrs(react, 'svga', ['href']))
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
