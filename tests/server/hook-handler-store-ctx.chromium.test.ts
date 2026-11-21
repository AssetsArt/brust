// F580 cells 7 and 8 in real Chromium: a function an inlined hook returns, used as an event handler BY NAME (`onClick={s.run}`
// or `const { run } = useX(); onClick={run}`), that reads a store (7) or a context value (8), directly or through a hook
// derived value. Each case in both spellings is its own route. The first half needs no browser: each page is served, its
// first paint equals React's own render, and the hook's components are native. The second half clicks: store cases assert
// the text React gives (it is plain from the source); context cases also run React hydrating the same page and compare.
// Run alone: `bun test --timeout 120000 tests/server/hook-handler-store-ctx.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import type { PAGES } from '../../packages/brust/test/fixtures/hook-handler-store-ctx/pages'
import { render } from '../../packages/brust/test/fixtures/hook-handler-store-ctx/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/hook-handler-store-ctx')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser | undefined
let reactJs = ''

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
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** The browser is started by the first click test only, so the first half runs where no browser is installed. */
async function chromium(): Promise<Browser> {
  if (!browser) {
    const { chromium } = await import('playwright')
    browser = await chromium.launch()
    const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
    if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
    reactJs = await r.outputs[0]!.text()
  }
  return browser
}

type Path = keyof typeof PAGES
/** The request each case is opened with: 8c gives its Provider a value from the loader. */
const query = (path: Path, who = 'ann') => (path.startsWith('/8c') ? `?who=${who}` : '')
const props = (path: Path, who = 'ann') => (path.startsWith('/8c') ? { who } : {})
const PATHS = [
  '/7a-m', '/7a-d', '/7b-m', '/7b-d', '/7c-m', '/7c-d', '/7d-m', '/7d-d', '/7e-m', '/7e-d',
  '/8a-m', '/8a-d', '/8b-m', '/8b-d', '/8c-m', '/8c-d', '/8d-m', '/8d-d', '/8e-m', '/8e-d', '/8f-m', '/8f-d',
  // F589: called from an inline handler, through the hook object (im) and destructured (id)
  '/7a-im', '/7a-id', '/7d-im', '/7d-id', '/8a-im', '/8a-id', '/8d-im', '/8d-id',
] as const satisfies readonly Path[]

/** Markup with brust's own wrappers, directives and hidden placeholders removed (the content React renders). */
const plain = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?brust-(?:host|if|island|frame)\b[^>]*>/g, '')
    .replace(/ (?:x-[\w:-]+|data-id|data-brust[\w-]*)="[^"]*"/g, '')
    .replace(/ x-[\w:-]+='[^']*'/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<template\b[\s\S]*?<\/template>/g, '')
    .replace(/<\/?span>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
const body = (html: string): string => /<main>[\s\S]*<\/main>/.exec(plain(html))?.[0] ?? plain(html)

// ---- first half: no browser ----

for (const path of PATHS) {
  test(`${path}: served 200 and first paint equals React's render`, async () => {
    const res = await fetch(`${base}${path}${query(path)}`)
    expect(res.status).toBe(200)
    expect(body(await res.text())).toBe(plain(render(path, props(path))))
  })
}

test('8c: a second request with another loader value paints that value', async () => {
  const res = await fetch(`${base}/8c-m${query('/8c-m', 'bob')}`)
  expect(body(await res.text())).toBe(plain(render('/8c-m', props('/8c-m', 'bob'))))
})

test("the hook's components are native (the proof is of the native path, not of React serving itself)", () => {
  const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  const tier = (name: string) => Object.entries(manifest.components).find(([k]) => k.startsWith(`${name}_`))?.[1].tier
  for (const name of ['s7aM', 's7aD', 's7bM', 's7bD', 's7cM', 's7cD', 's7dM', 's7dD', 'inst7eM', 'inst7eD', 'rM', 'rD', 'dM', 'dD', 's7aIM', 's7aID', 's7dIM', 's7dID', 'rIM', 'rID']) {
    expect([name, tier(name)]).toEqual([name, 'native'])
  }
})

// ---- second half: clicks in Chromium ----

/** A step: click `click` (none: the first paint), then wait until every named button shows its text. */
type Step = [click: string | null, want: Record<string, string>]
const SCENARIOS: Record<string, Step[]> = {
  '7a': [[null, { run: 'none' }], ['run', { run: 'n=1' }]],
  '7b': [[null, { run: 'none' }], ['run', { run: 'n=1' }]],
  '7c': [[null, { run: '1' }], ['run', { run: '2' }], ['run', { run: '3' }]],
  // the handler reads the CURRENT value another component wrote, not the first paint's
  '7d': [[null, { run: 'none' }], ['run', { run: 'n=1' }], ['bump', { run: 'n=1' }], ['run', { run: 'n=2' }], ['bump', {}], ['bump', {}], ['run', { run: 'n=4' }]],
  // two instances of one hook: each its own state, both reading the one store
  '7e': [[null, { a: 'none', b: 'none' }], ['bump', {}], ['a', { a: 'n=2', b: 'none' }], ['bump', {}], ['b', { a: 'n=2', b: 'n=3' }]],
  '8a': [[null, { a: 'none' }], ['a', { a: 'c=alpha' }]],
  '8b': [[null, { a: 'none' }], ['a', { a: 'c=alpha' }]],
  '8c': [[null, { a: 'none' }], ['a', { a: 'c=ann' }]],
  '8d': [[null, { a: 'none', b: 'none' }], ['a', { a: 'c=one', b: 'none' }], ['b', { a: 'c=one', b: 'c=two' }]],
  '8e': [[null, { a: 'none', b: 'none' }], ['a', { a: 'c=outer', b: 'none' }], ['b', { a: 'c=outer', b: 'c=inner' }]],
  '8f': [[null, { a: 'none' }], ['a', { a: 'c=dflt' }]],
}

async function play(open: (page: Page) => Promise<void>, steps: Step[]) {
  const page = await (await chromium()).newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await open(page)
  const log: unknown[] = []
  for (const [click, want] of steps) {
    if (click) await page.getByTestId(click).click()
    const ok = await page
      .waitForFunction((w) => Object.entries(w).every(([id, t]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === t), want, { timeout: 5000 })
      .then(() => true, () => false)
    const seen = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null])), Object.keys(want))
    log.push({ click, seen, ok })
  }
  await page.close()
  return { log, errors }
}
const expected = (steps: Step[]) => steps.map(([click, want]) => ({ click, seen: want, ok: true }))

for (const path of PATHS) {
  const steps = SCENARIOS[path.slice(1, 3)]!
  test(`${path}: the clicks give React's result`, async () => {
    const served = await play(async (page) => {
      await page.goto(`${base}${path}${query(path)}`, { waitUntil: 'networkidle' })
    }, steps)
    expect(served.errors).toEqual([])
    expect(served.log).toEqual(expected(steps))
    if (path.startsWith('/8')) {
      // React hydrating the same page gives the same log
      const name = `C${path.slice(1, 3)}${path.slice(4).toUpperCase()}`
      const react = await play(async (page) => {
        await page.route('http://react.test/**', (route) =>
          route.request().url().endsWith('/app.js')
            ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
            : route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><body><div id="root">${render(path, props(path))}</div><script>window.__page=${JSON.stringify(name)};window.__props=${JSON.stringify(props(path))}</script><script src="/app.js"></script></body></html>`,
              }),
        )
        await page.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
      }, steps)
      expect(react.errors).toEqual([])
      expect(served.log).toEqual(react.log)
    }
  }, 60_000)
}
