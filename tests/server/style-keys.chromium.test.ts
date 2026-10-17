// F383 in real Chromium: a style object with literal computed keys (`[`--panel-height` as any]`, Radix
// CollapsibleContent's shape) plus a spread of the caller's style, behind a stateless wrapper that spreads its props in.
// The style was a per-request job over the whole props, so the wrapper was refused (spread-fed) and the page shipped a
// React island. Now first paint equals React's own render, and the CSSOM follows the state after clicks.
// Run alone: `bun test --timeout 120000 tests/server/style-keys.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderStyle } from '../../packages/brust/test/fixtures/style-keys/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/style-keys')
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

/** Markup with brust's own wrappers, directives and hidden placeholders removed (the content React renders). */
const plain = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?brust-host\b[^>]*>/g, '')
    .replace(/ (?:x-[\w:-]+|data-id)="[^"]*"/g, '')
    .replace(/ x-[\w:-]+='[^']*'/g, '')
    .replace(/<script\b[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()

test('/style: served 200, no React island, and first paint equals React\'s own render', async () => {
  const res = await fetch(`${base}/style`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toContain(plain(renderStyle()))
})

test('/style: the CSSOM holds every key, and the computed-key one follows the state', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/style`, { waitUntil: 'networkidle' })
  const css = () =>
    page.getByTestId('panel').evaluate((el: HTMLElement) => ({
      height: el.style.getPropertyValue('--panel-height'),
      kind: el.style.getPropertyValue('--panel-kind'),
      color: el.style.color,
    }))
  expect(await css()).toEqual({ height: '', kind: 'box', color: 'red' })
  await page.getByTestId('panel').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="panel"]') as HTMLElement).style.getPropertyValue('--panel-height') === '10px')
  await page.getByTestId('panel').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="panel"]') as HTMLElement).style.getPropertyValue('--panel-height') === '20px')
  expect(await css()).toEqual({ height: '20px', kind: 'box', color: 'red' })
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
