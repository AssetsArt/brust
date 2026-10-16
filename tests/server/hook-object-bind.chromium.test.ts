// F289 in real Chromium: a hook that returns an object (or array) holding a handler, bound whole at the call site
// (`const t = useToggle(); t.on / t.toggle`). It used to be a per-request job naming the handler's generated local: a
// ReferenceError and a 500. Now each page is served, first paint equals React's own render, and the clicks work.
// Run alone: `bun test --timeout 120000 tests/server/hook-object-bind.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderComp, renderCompDestruct, renderDestructured, renderMemo, renderWhole } from '../../packages/brust/test/fixtures/hook-object-bind/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/hook-object-bind')
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
    .replace(/<\/?brust-if\b[^>]*>/g, '')
    .replace(/ (?:x-[\w:-]+|data-id)="[^"]*"/g, '')
    .replace(/ x-[\w:-]+='[^']*'/g, '')
    .replace(/<script\b[\s\S]*$/, '')
    .replace(/<\/?span>/g, '').replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/ hidden=""/g, ' hidden')
    .trim()

const pages: [string, () => string][] = [
  ['/whole', renderWhole],
  ['/destructured', renderDestructured],
]

test('/memo: a returned useMemo / spread (not a literal) is served and keeps React\'s markup', async () => {
  const res = await fetch(`${base}/memo`)
  expect(res.status).toBe(200)
  expect(plain(await res.text())).toContain(plain(renderMemo()).replace(/^<main>|<\/main>$/g, ''))
})


for (const [path, react] of pages) {
  test(`${path}: served 200, no React island, and first paint equals React's own render`, async () => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('brust-island')
    expect(plain(html)).toContain(plain(react()).replace(/^<main>|<\/main>$/g, ''))
  })
}

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[x-data]') !== null)
  return { page, errors }
}

test('a hook object bound whole: t.on / t.toggle, a computed member and a hook array work', async () => {
  const { page, errors } = await open('/whole')
  await page.getByTestId('tog').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="tog"]')?.textContent === 'on')
  await page.getByTestId('cnt').click()
  await page.getByTestId('cnt').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="cnt"]')?.textContent === '+2:4')
  await page.getByTestId('pair').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="pair"]')?.textContent === 'yes')
  await page.getByTestId('tog').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="tog"]')?.textContent === 'off')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('the destructured form of the same hook still works', async () => {
  const { page, errors } = await open('/destructured')
  await page.getByTestId('tog').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="tog"]')?.textContent === 'on')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('/memo: the clicks work on the React-tier page', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/memo`, { waitUntil: 'networkidle' })
  await page.getByTestId('memo').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="memo"]')?.textContent === 'on')
  await page.getByTestId('spread').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="spread"]')?.textContent === 'xon')
  await page.getByTestId('held').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="held"]')?.textContent === 'on')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

for (const [path, id, react] of [
  ['/comp', 'comp', renderComp],
  ['/comp-destruct', 'compd', renderCompDestruct],
] as const) {
  test(`${path}: a value computed from a handler is served (React tier), equals React's markup, and the click works`, async () => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(200)
    expect(plain(await res.text())).toContain(plain(react()).replace(/^<main>|<\/main>$/g, ''))
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.getByTestId(id).click()
    await page.waitForFunction((t) => document.querySelector(`[data-testid="${t}"]`)?.textContent === 'on', id)
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
}
