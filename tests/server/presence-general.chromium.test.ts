// F284-F287 in real Chromium: an arrow-const component, `useReducer` (direct and through a custom hook that returns it),
// hook calls hoisted out of a returned object, and `[literals].includes(state)`: each page lowers without a React island,
// first paint equals React's own render, and the interaction gives what React gives.
// Run alone: `bun test --timeout 120000 tests/server/presence-general.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderArrow, renderHoist, renderIncludes, renderReducer } from '../../packages/brust/test/fixtures/presence-general/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/presence-general')
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
  ['/arrow', renderArrow],
  ['/reducer', renderReducer],
  ['/hoist', renderHoist],
  ['/includes', renderIncludes],
]

for (const [path, react] of pages) {
  test(`${path}: no React island, and first paint equals React's own render`, async () => {
    const html = await (await fetch(`${base}${path}`)).text()
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

test('F284: an arrow-const component, by its name and by its alias, counts on its own', async () => {
  const { page, errors } = await open('/arrow')
  await page.getByTestId('named').click()
  await page.getByTestId('alias').click()
  await page.getByTestId('alias').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="alias"]')?.textContent === 'alias:7')
  expect(await page.getByTestId('named').textContent()).toBe('named:3')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F285: a reducer (module, and through a custom hook) steps like React, and dispatch keeps one identity', async () => {
  const { page, errors } = await open('/reducer')
  expect(await page.getByTestId('state').textContent()).toBe('a')
  await page.getByTestId('go').click()
  await page.getByTestId('go').click()
  await page.getByTestId('go').click() // c has no GO: stays
  await page.waitForFunction(() => document.querySelector('[data-testid="state"]')?.textContent === 'c')
  await page.getByTestId('back').click() // c has no BACK: stays
  await page.getByTestId('add').click()
  await page.getByTestId('add').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="sum"]')?.textContent === '6')
  expect(await page.getByTestId('state').textContent()).toBe('c')
  // the effect that depends on both dispatches ran once at mount: their identity never changed
  expect(await page.getByTestId('runs').textContent()).toBe('1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F286: hooks hoisted out of a returned object and out of a returned useState work', async () => {
  const { page, errors } = await open('/hoist')
  await page.getByTestId('inc').click()
  await page.getByTestId('inc').click()
  await page.getByTestId('tog').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="inc"]')?.textContent === '3')
  expect(await page.getByTestId('tog').textContent()).toBe('toggle:on')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('F287: includes over state follows a prop the page changes', async () => {
  const { page, errors } = await open('/includes')
  expect(await page.getByTestId('shown').isVisible()).toBe(true)
  await page.getByTestId('flip').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="shown"]')?.hasAttribute('hidden'))
  expect(await page.getByTestId('odd').textContent()).toBe('yes')
  await page.getByTestId('num').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="odd"]')?.textContent === 'yes')
  await page.getByTestId('flip').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="shown"]')?.hasAttribute('hidden'))
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
