// F379 in real Chromium: custom hooks called inside attribute values of the returned tree (Radix Collapsible's
// `contentId={useId()}`, `useId` being @radix-ui/react-id's own hook). They were refused ('hook ... is called inside an
// expression'); now each call is inlined before the return, the first paint equals React's own render, and the values
// follow the state.
// Run alone: `bun test --timeout 120000 tests/server/custom-hook-hoist.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderAttr, renderId } from '../../packages/brust/test/fixtures/custom-hook-hoist/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/custom-hook-hoist')
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

/** useId values differ between two renderers; the rest of the markup must not. */
const noIds = (html: string): string => html.replace(/(for|id)="([fd])-[^"]*"/g, '$1="$2-ID"')

test('/attr: served 200, no React island, and first paint equals React\'s own render', async () => {
  const res = await fetch(`${base}/attr`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).not.toContain('brust-island')
  expect(plain(html)).toContain(plain(renderAttr()))
})

test('/id: served 200, no React island, and first paint equals React\'s own render but for the id values', async () => {
  const res = await fetch(`${base}/id`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).not.toContain('brust-island')
  expect(noIds(plain(html))).toContain(noIds(plain(renderId())))
})

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  return { page, errors }
}

test('/attr: the hoisted values hold after clicks (the seeded state stays, the derived one follows)', async () => {
  const { page, errors } = await open('/attr')
  const b = page.getByTestId('attr')
  expect(await b.getAttribute('title')).toBe('L2')
  expect(await b.getAttribute('data-twice')).toBe('0')
  await b.click()
  await b.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="attr"]')?.textContent === '2')
  expect(await b.getAttribute('data-twice')).toBe('4')
  expect(await b.getAttribute('title')).toBe('L2')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('/id: two calls give two distinct, prefixed ids', async () => {
  const { page, errors } = await open('/id')
  const f = await page.getByTestId('label').getAttribute('for')
  const d = await page.getByTestId('desc').getAttribute('id')
  expect(f).toMatch(/^f-.+/)
  expect(d).toMatch(/^d-.+/)
  expect(f!.slice(2)).not.toBe(d!.slice(2))
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
