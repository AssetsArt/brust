// F296 (spread-live, option A) in real Chromium: a live `style` that lands through a static forwarder's `{...props}`
// spread is bound by the parent on the forwarder's element (`x-bind-style`), so nothing links the forwarder. Fifteen
// style and class shapes (edge values: 0, unitless numbers, vendor prefixes, custom properties, an empty object, undefined and
// null members, boolean values, a trimmed string, a negative number, a forwarder with its own `style` that a live
// `undefined` must drop) each equal React's render: on first paint (the served HTML, compared attribute by attribute)
// and after a click (the live DOM). Also asserts the forwarder is static, with no client chunk of its own.
// Run alone: `bun test --timeout 120000 tests/server/live-style.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderCases } from '../../packages/brust/test/fixtures/live-style/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/live-style')
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

const CASES = 15

/** The `style` and `class` attributes of each `<div data-case="n">` in a page's markup, `style=…|class=…`: `null` parts are absent. */
function styles(html: string): (string | null)[] {
  return Array.from({ length: CASES }, (_, i) => {
    const tag = new RegExp(`<div[^>]*data-case="${i}"[^>]*>`).exec(html)?.[0] ?? ''
    const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1] ?? null
    return `style=${attr('style')}|class=${attr('class')}`
  })
}

test('the forwarder is static and unlinked: no chunk of its own, no props crossing to it', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist', 'manifest.json'), 'utf8'))
  const comps = Object.entries(m.components) as [string, any][]
  const fwd = comps.filter(([id]) => /^fwd/i.test(id))
  expect(fwd.length).toBeGreaterThan(0)
  for (const [id, c] of fwd) {
    expect(c.tier, id).toBe('static')
    expect(c.client, id).toBeNull()
  }
})

test('first paint equals React for every style shape', async () => {
  const served = styles(await (await fetch(`${base}/`)).text())
  expect(served).toEqual(styles(renderCases(false)))
})

test('after a click the live DOM equals React for every style shape, and a live undefined drops the forwarder\'s own style', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  // an absent attribute and an empty one are the same declarations (style) -- compared as the empty string below
  const read = () =>
    page.evaluate(
      (n) =>
        Array.from({ length: n }, (_, i) => {
          const el = document.querySelector(`[data-case="${i}"]`)
          return `style=${el?.getAttribute('style') ?? null}|class=${el?.getAttribute('class') ?? null}`
        }),
      CASES,
    )
  // a click before the chunk hydrates is dropped (server HTML): click until the first style changes
  const flip = async (from: string) => {
    for (let i = 0; i < 20; i++) {
      await page.getByTestId('flip').click()
      const moved = await page
        .waitForFunction((f) => {
          const el = document.querySelector('[data-case="0"]')
          return `style=${el?.getAttribute('style') ?? null}|class=${el?.getAttribute('class') ?? null}` !== f
        }, from, { timeout: 500 })
        .then(() => true, () => false)
      if (moved) return
    }
    throw new Error('the page never hydrated')
  }
  const want = styles(renderCases(true))
  await flip((await read())[0]!)
  // F311: the binder removes `style`/`class` where React has none, so the live DOM equals React's render exactly
  expect(await read()).toEqual(want)
  // case 9: the live `undefined` replaced the forwarder's own `style` with nothing (React keeps no own style either)
  expect(want[9]).toBe('style=null|class=null')
  expect((await read())[9]).toBe('style=null|class=null')
  // case 13: the same for `className`: a live `undefined` drops the forwarder's own class
  expect(want[13]).toBe('style=null|class=null')
  expect((await read())[13]).toBe('style=null|class=null')
  // and back: the first state again
  const back = styles(renderCases(false))
  await flip((await read())[0]!)
  expect(await read()).toEqual(back)
  expect(errors).toEqual([])
  await page.close()
})
