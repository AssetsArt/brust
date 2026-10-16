// F282: an object literal a native page hands to a React island crosses as PROPS-JSON in its SOURCE order (as
// JSON.stringify writes it), not sorted by key. Order is visible in two ways: a style's declarations (`marginTop: 5, margin: 0`
// ends with margin-top 0 in React; sorted, `margin: 0` came first and margin-top stayed 5) and `JSON.stringify` of any
// object the island shows. The served island markup (server render) and the hydrated DOM (client render from the `x-props`
// JSON) each equal React's own render of the same component.
// Run alone: `bun test --timeout 120000 tests/server/props-order.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderBox } from '../../packages/brust/test/fixtures/props-order/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/props-order')
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

const style = (html: string) => /<div[^>]*data-testid="box"[^>]*\sstyle="([^"]*)"/.exec(html)?.[1] ?? null
const cfg = (html: string) => /<code data-testid="cfg">([^<]*)<\/code>/.exec(html)?.[1]?.replace(/&quot;/g, '"') ?? null

test('the served island markup equals React\'s render of the same props', async () => {
  const served = await (await fetch(`${base}/`)).text()
  const react = renderBox()
  expect(react).toContain('style="margin-top:5px;margin:0;color:red"')
  expect(style(served)).toBe(style(react))
  expect(cfg(served)).toBe(cfg(react))
  expect(cfg(react)).toBe('{"z":1,"a":{"y":2,"b":3},"m":[{"q":1,"c":2}]}')
})

test('after hydration the island still shows React\'s order, and margin-top is 0', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
  const react = renderBox()
  const now = await page.evaluate(() => ({
    style: document.querySelector('[data-testid="box"]')?.getAttribute('style') ?? null,
    cfg: document.querySelector('[data-testid="cfg"]')?.textContent ?? null,
    marginTop: getComputedStyle(document.querySelector('[data-testid="box"]')!).marginTop,
  }))
  expect(now.style).toBe(style(react))
  expect(now.cfg).toBe(cfg(react))
  expect(now.marginTop).toBe('0px')
  expect(errors).toEqual([])
  await page.close()
})
