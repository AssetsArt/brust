// F348: livewrap = a wrapper with an instance of its own passing its changing prop to the Provider it specialises (F345): the wrapper
// and its clone follow the page; served == React after each change.
// F307 (option B) in real Chromium, against React hydrating the same page in the same browser. Slot content a caller
// prints inside a child's own host (`slot-owner`, F214 for a native child, F309 for a static child linked at the call
// site) is compiled into a clone of the child for that call site, so the content's directives are the clone's own: a
// state read (state), a bare text slot (text), a handler of the caller (handler), a list over state (list), a linked
// component (linked), a static child linked at the call site (linked_static), content handed on through a static
// wrapper (two_levels), a clone mounted late under the page's condition after the state changed (ifmount, S6), a
// consumer that hosts the page's live text inside a specialised Provider's content (nested), a host inside a Provider's
// content whose own content consumes that Provider (scoped, S2: cloned inside the Provider's clone, where the frame is
// the clone's own), and Radix Switch's
// Root/Thumb shape, where the trigger the rest is spread into reads the context itself (switch, F298 + F309).
// A stateless wrapper's own changing prop in such content is cloned too, but the wrapper does not follow it (F323), so
// the page is refused `frozen-prop` (prop). Unchanged: content without a directive (const), a child that reads its children as a value (gate, children-read) and a
// child whose children reach its element only through its rest (rest, S1/F324). Every observable value equals React.
// Run alone: `bun test --timeout 120000 tests/server/host-specialise.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/host-specialise/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/host-specialise')
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
 * component's host) have no box and are not observed. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !['brust-row', 'brust-if', 'brust-host'].includes(e.localName)).map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

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

test('slot content a child prints inside its own host is cloned with the child per call site; the rest keeps its refusal', () => {
  expect({ const: tierOf('pConst_'), state: tierOf('pState_'), text: tierOf('pText_'), handler: tierOf('pHandler_'), list: tierOf('pList_'), linked: tierOf('pLinkedChild_'), linked_static: tierOf('pLinkedStatic_'), two_levels: tierOf('pTwoLevels_'), ifmount: tierOf('pIfmount_'), nested: tierOf('pNested_'), prop: tierOf('pProp_'), scoped: tierOf('pScoped_'), switch: tierOf('pSwitch_'), gate: tierOf('pGate_'), rest: tierOf('pRest_'), livewrap: tierOf('pLivewrap_'), livewrap_wrapper: tierOf('liveWrap_') }).toEqual({ const: 'native', state: 'native', text: 'native', handler: 'native', list: 'native', linked: 'native', linked_static: 'native', two_levels: 'native', ifmount: 'native', nested: 'native', prop: 'react', scoped: 'native', switch: 'static', gate: 'react', rest: 'react', livewrap: 'native', livewrap_wrapper: 'native' })
})

const CLICKS: Record<string, string[]> = { rows: ['f', 'add', 'b3', 'in3', 'rm', 'b2', 'f', 'add', 'b4', 'in4'], rows_free: ['f', 'add', 'b3', 'rm', 'b2', 'f', 'add', 'b4', 'f'], many_same: ['f', 'f', 'f'], many_diff: ['f', 'f', 'f'], livewrap: ['f', 'box', 'f', 'f', 'box'], ifmount: ['f', 'g', 'box', 'f', 'g', 'f', 'g'], linked_static: ['f', 'f'], nested: ['f', 'box', 'f', 'box'], switch: ['box', 'box', 'box'], scoped: ['f', 't', 'box', 'f', 't'] }
// F344 (1): a host in list rows from state. Content reading the row value (or a row handler) is refused by name
// (host-specialise-unsupported, then slot-owner: the page renders with React); content reading page state only is
// cloned per row, and the host's own row-valued prop is followed, not pinned (pinned, a row added on the client printed
// the first row's id).
test('rows: refused by name (React island); rows_free: cloned in the rows (no island)', async () => {
  expect(await (await fetch(`${base}/rows`)).text()).toContain('brust-island')
  const free = await (await fetch(`${base}/rows_free`)).text()
  expect(free).not.toContain('brust-island')
  expect(free).toMatch(/x-data="rBox_\w+_h[0-9a-f]{8}"/)
})

// F344 (2), ruling c08d26c0 (no dedupe; row F359 dedupes by shape): the same host at 20 call sites makes one clone per
// call site, identical contents or not (20 clone scripts on the page, measured ~156 B gz each when identical), built
// once (no growth per render: the same page served twice is the same bytes); toggled, every value equals React.
for (const page of ['many_same', 'many_diff']) {
  test(`${page}: 20 call sites, 20 clones, the same bytes on every render`, async () => {
    const a = await (await fetch(`${base}/${page}`)).text()
    const b = await (await fetch(`${base}/${page}`)).text()
    expect(b).toBe(a)
    expect(a).not.toContain('brust-island')
    const clones = new Set([...a.matchAll(/x-data="(box_\w+_h[0-9a-f]{8})"/g)].map((m) => m[1]))
    expect(clones.size).toBe(20)
  })
}

for (const page of ['const', 'state', 'text', 'handler', 'list', 'linked', 'linked_static', 'two_levels', 'ifmount', 'nested', 'prop', 'scoped', 'switch', 'gate', 'rest', 'livewrap', 'rows', 'rows_free', 'many_same', 'many_diff']) {
  test(`${page}: every observable value equals React hydrating the same page after each click`, async () => {
    const react = await run(page, true, CLICKS[page])
    const served = await run(page, false, CLICKS[page])
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
