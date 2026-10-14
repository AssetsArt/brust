// F178 in real Chromium: a native component with local object-literal constants read by handlers and by the template
// builds (the chunk used to carry `computed(() => { up: 2 })`, a syntax error), its first paint equals React's own render of
// the same source, and clicking behaves as React would: up adds 2, down subtracts 1.
// Run alone: `bun test --timeout 120000 tests/server/object-literal-arrow.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderStepper } from '../../packages/brust/test/fixtures/object-literal-arrow/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/object-literal-arrow')
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

const text = (html: string) => html.replaceAll('<!-- -->', '').replace(/\s+/g, ' ')

/** The visible text and the `data-unit` of the `<output>`: markup differs (brust marks text nodes with spans), content must not. */
const outputOf = (html: string) => {
  const m = /<output([^>]*)>([\s\S]*?)<\/output>/.exec(text(html))!
  return { unit: /data-unit="([^"]*)"/.exec(m[1]!)![1], text: m[2]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() }
}

test('first paint equals React\'s own render of the same source', async () => {
  const served = outputOf(await (await fetch(`${base}/`)).text())
  const react = outputOf(renderStepper())
  expect(react).toEqual({ unit: '0', text: 'count: 0' })
  expect(served).toEqual(react)
})

test('clicks follow the object constants, and the page has no console error', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  const out = page.getByTestId('out')
  await page.getByTestId('up').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="out"]')?.textContent?.includes('count: 2'))
  await page.getByTestId('up').click()
  await page.getByTestId('down').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="out"]')?.textContent?.includes('count: 3'))
  expect(await out.getAttribute('data-unit')).toBe('3')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
