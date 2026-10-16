// F318: a style object that reaches a native page as LOADER data (the worker writes it with JSON.stringify; brust-jinja's render
// tree is sorted) keeps the worker's key order wherever React's order decides: printed as a `style` attribute, and crossing as the
// island's props JSON. `marginTop: 5, margin: 0` ends with margin-top 0 in React. Iteration order of the data stays sorted.
// Run alone: `bun test --timeout 120000 tests/server/loader-style.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/loader-style/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/loader-style')
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

const attr = (html: string, id: string, name: string) => new RegExp(`<[^>]*data-testid="${id}"[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1] ?? null
const list = (html: string) => [...(/<ul[^>]*data-testid="list"[^>]*>(.*?)<\/ul>/s.exec(html)?.[1] ?? '').matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!.replace(/<!--.*?-->/g, '')).join('|')
const cfg = (html: string) => /<code data-testid="cfg">([^<]*)<\/code>/.exec(html)?.[1]?.replace(/&quot;/g, '"') ?? null

test("the served page equals React: a loader style prints in the worker's order, on a native element and on the island", async () => {
  const served = await (await fetch(`${base}/`)).text()
  const react = renderPage()
  expect(attr(react, 'plain', 'style')).toBe('margin-top:5px;margin:0;color:red')
  expect(attr(served, 'plain', 'style')).toBe(attr(react, 'plain', 'style'))
  expect(attr(served, 'box', 'style')).toBe(attr(react, 'box', 'style'))
  expect(cfg(served)).toBe(cfg(react))
  expect(cfg(react)).toBe('{"z":1,"a":{"y":2,"b":3}}')
  // F2: a spread of the runtime style keeps its order; F1: Object.entries of a runtime object iterates in the JS (text) order
  expect(attr(react, 'spread', 'style')).toBe('margin-top:5px;margin:0;color:red;position:absolute')
  expect(attr(served, 'spread', 'style')).toBe(attr(react, 'spread', 'style'))
  expect(list(served)).toBe(list(react))
  expect(list(react)).toBe('zeta=z|alpha=a|mid=m')
})

test("after hydration the island still shows React's order and margin-top is 0", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
  const react = renderPage()
  const now = await page.evaluate(() => ({
    style: document.querySelector('[data-testid="box"]')?.getAttribute('style') ?? null,
    cfg: document.querySelector('[data-testid="cfg"]')?.textContent ?? null,
    spread: document.querySelector('[data-testid="spread"]')?.getAttribute('style') ?? null,
    list: [...document.querySelectorAll('[data-testid="list"] li')].map((l) => l.textContent).join('|'),
    plain: getComputedStyle(document.querySelector('[data-testid="plain"]')!).marginTop,
  }))
  expect(now.style).toBe(attr(react, 'box', 'style'))
  expect(now.cfg).toBe(cfg(react))
  expect(now.plain).toBe('0px')
  expect(now.spread).toBe(attr(react, 'spread', 'style'))
  expect(now.list).toBe(list(react))
  expect(errors).toEqual([])
  await page.close()
})
