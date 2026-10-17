// switch-provider-chain PR1 (+ F345) in real Chromium, against React hydrating the same page in the same browser:
// Radix Switch's shape in app code (a render prop called with the Provider's own context object, a trigger handing the
// context to a static button before the caller's rest, and a Thumb travelling in that rest). A context value of a state
// Provider must never be pinned in a clone (F345): pinned, the trigger's clone printed `data-state` once and the
// switch stayed `unchecked` after a click. Toggled twice, every observable value equals React (thumb, bare).
// Run alone: `bun test --timeout 120000 tests/server/switch-chain.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/switch-chain/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/switch-chain')
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

/** Tag, data-* attributes and leaf text of every element under <main>; brust's `display: contents` wrappers (`<brust-row>`,
 * a row whose root is a condition, `<brust-if>`, a condition over a component, and `<brust-host>`, a specialised
 * component's host) have no box, and `<brust-island>` is the wrapper of a React island (a page that falls back): none
 * is observed. Attributes are sorted: a live value the parent binds on a child's element (switch-provider-chain PR2) is
 * printed ahead of the element's own spread, an order no reader of the DOM observes. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !['brust-row', 'brust-if', 'brust-host', 'brust-island'].includes(e.localName)).map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).sort().join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

async function run(page: string, react: boolean, clicks = ['f', 'box', 'f']): Promise<{ log: string[]; errors: string[] }> {
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

const tierOf = (prefix: string) => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  return Object.entries(m.components).find(([k]) => k.startsWith(prefix))![1].tier
}

// PR2 (link 3): the trigger binds the context's live `data-state` ahead of its own rest, so `bare` is served natively;
// PR3 (children-rest): the Thumb carried in that rest is linked by the trigger's clone, so `thumb` is too.
for (const page of ['bare', 'thumb']) {
  test(`${page} is served without a React island`, async () => {
    expect(tierOf('kRoot_')).not.toBe('react')
    const html = await (await fetch(`${base}/${page}`)).text()
    expect(html).not.toContain('brust-island')
  })
}

for (const page of ['thumb', 'bare']) {
  test(`${page}: toggled twice, every observable value equals React hydrating the same page`, async () => {
    const react = await run(page, true, ['box', 'box'])
    const served = await run(page, false, ['box', 'box'])
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    // React's own toggle, so a value printed once (stale) cannot pass
    expect(react.log.map((l) => /data-state=(\w+)/.exec(l)?.[1])).toEqual(['unchecked', 'checked', 'unchecked'])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}

// PR3 D1 (ruling: pinned behaviour, row F357 tightens it): a Provider whose value never changes still links the Thumb
// carried in the rest; the output equals React's, and a click (a setter that does nothing) changes nothing.
test('const: a constant frame, served without an island, equals React', async () => {
  const html = await (await fetch(`${base}/const`)).text()
  expect(html).not.toContain('brust-island')
  expect(html).toContain('x-props-bind')
  const react = await run('const', true, ['box'])
  const served = await run('const', false, ['box'])
  expect(react.errors).toEqual([])
  expect(served.errors).toEqual([])
  expect(react.log.map((l) => /data-thumb=(\w+)/.exec(l)?.[1])).toEqual(['checked', 'checked'])
  expect(served.log).toEqual(react.log)
}, 90_000)

// PR3 D2: switches in list rows whose items come from state, the row value (`data-testid`) reaching the Root's rest, which
// the Root reads where it would not follow a change: a row the client adds would keep the first row's value (it printed
// `b1` in row 3), so the call site refuses by name (`frozen-prop`) and the page renders with React. With the Thumb in the
// rest (PR3) and without it (PR2's bare trigger), after an add, a remove and toggles, every value equals React's.
for (const page of ['rows', 'rows_bare']) {
  test(`${page}: list rows from state (add, remove, toggles) equal React at every step`, async () => {
    const html = await (await fetch(`${base}/${page}`)).text()
    expect(html).toContain('brust-island')
    const clicks = ['b1', 'add', 'b3', 'rm', 'b2', 'b3', 'add', 'b4']
    const react = await run(page, true, clicks)
    const served = await run(page, false, clicks)
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    // React's own rows: the toggled ones flip, the removed row is gone, an added row starts unchecked
    expect(react.log.at(-1)).toContain('section[data-row=4]')
    expect(react.log.at(-1)).not.toContain('section[data-row=1]')
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
