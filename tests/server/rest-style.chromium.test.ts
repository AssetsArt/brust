// B5 in real Chromium: `style={{ ...props.style, ...size, ... }}` with `props` the `...rest` object: first paint equals
// React's render, and a click recomputes it. Run alone: `bun test --timeout 120000 tests/server/rest-style.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/rest-style/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/rest-style')
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

/** The `style` of the page's `<input>`, as the browser would parse it (whitespace and order normalised). */
const inputStyle = (html: string): string[] => {
  const m = /<input[^>]*\sstyle="([^"]*)"/.exec(html)
  return (m?.[1] ?? '').split(';').map((x) => x.trim().replace(/\s+/g, '')).filter(Boolean).sort()
}

test("first paint's style equals React's own render", async () => {
  const served = inputStyle(await (await fetch(`${base}/`)).text())
  const react = inputStyle(renderPage())
  expect(react).toContain('position:absolute')
  expect(served).toEqual(react)
})

test('a click recomputes the style from the same spread, like React would', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="box"]')?.hasAttribute('x-data'))
  await page.getByTestId('box').click()
  // n = 2: width comes from the computed size (20px), after the prop's width (99px), height 5px, colour from the prop
  await page.waitForFunction(() => (document.querySelector('input') as HTMLInputElement).style.width === '20px')
  const st = await page.evaluate(() => {
    const s = (document.querySelector('input') as HTMLInputElement).style
    return [s.color, s.width, s.height, s.position, s.opacity]
  })
  expect(st).toEqual(['red', '20px', '5px', 'absolute', '0'])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
