// F238 in real Chromium, against React hydrating the same page in the same browser. A native Provider (Frame) called
// inside another one's template (Prov) around its {children} is specialised per clone of Prov with THAT clone's content
// (two_on); content reading Frame's own context keeps Prov an island (two: before, it printed the context default);
// content holding a Frame call at the very offset of Prov's own Frame call nests as in React when it is a clone
// where it is written (same_loc3) and keeps Prov an island when it is still a React island there (same_loc, F3). Every
// observable value equals React after each click. F374: children a wrapper hands on to Prov in a spread (rest_text,
// rest_k) keep the wrapper a React island; rest_on (content reading Prov's own context) clones the wrapper (F298).
// Run alone: `bun test --timeout 120000 tests/server/clone-cache.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/clone-cache/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/clone-cache')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let reactJs = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
  if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
  reactJs = await r.outputs[0]!.text()
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

/** Tag, data-* attributes and leaf text of every element under <main>; brust's `display: contents` wrappers have no box
 * and are not observed. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !['brust-row', 'brust-if', 'brust-host', 'brust-island'].includes(e.localName)).map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

async function run(page: string, react: boolean, clicks: string[]): Promise<{ log: string[]; errors: string[] }> {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  if (react) {
    await p.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root">${renderPage(page)}</div><script>window.__page = ${JSON.stringify(page)}</script><script src="/app.js"></script></body></html>` }),
    )
    await p.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  } else {
    await p.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => document.querySelector('[x-data], [data-hydrated]') !== null)
  }
  await p.waitForTimeout(300)
  const log = [await observe(p)]
  for (const id of clicks) {
    await p.locator(`[data-testid="${id}"]`).click()
    await p.waitForTimeout(150)
    log.push(await observe(p))
  }
  await p.close()
  return { log, errors }
}

test('two_on and same_loc3 are native (no island); same_loc (F3) and two (a Provider inside Prov) keep Prov an island', async () => {
  for (const page of ['two_on', 'same_loc3']) expect(await (await fetch(`${base}/${page}`)).text()).not.toContain('brust-island')
  for (const page of ['same_loc', 'two']) expect(await (await fetch(`${base}/${page}`)).text()).toContain('<brust-island data-id="prov_')
})

// F374: children reaching the Provider through a wrapper's props spread: the wrapper stays a React island (refused by
// name), never the Provider printed without them; content reading Prov's own context still clones the wrapper (F298).
test('rest_text and rest_k keep the wrapper an island with its children; rest_on is native', async () => {
  const text = await (await fetch(`${base}/rest_text`)).text()
  expect(text).toContain('<brust-island data-id="outer_')
  expect(text).toContain('hello')
  expect(text).toContain('para')
  const k = await (await fetch(`${base}/rest_k`)).text()
  expect(k).toContain('<brust-island data-id="outer_')
  expect(k).toContain('AAA')
  expect(await (await fetch(`${base}/rest_on`)).text()).not.toContain('brust-island')
})

const CLICKS: Record<string, string[]> = {
  two: ['t1', 'f1', 't2', 'f2', 'f2', 't1'],
  two_on: ['t1', 'f1', 't2', 'f2', 't1'],
  rest_text: ['t1', 'f1', 't2', 'f2'],
  rest_k: ['t1', 'f1', 't1'],
  rest_on: ['t1', 'f1', 't1'],
  same_loc: ['t1', 'fin', 'f1', 't1'],
  same_loc3: ['t1', 'fin', 'f1', 'fin', 't1'],
}

for (const page of Object.keys(CLICKS)) {
  test(`${page}: every observable value equals React hydrating the same page after each click`, async () => {
    const react = await run(page, true, CLICKS[page]!)
    const served = await run(page, false, CLICKS[page]!)
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
