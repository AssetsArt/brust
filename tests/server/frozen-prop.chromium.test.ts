// F319 in real Chromium, against React hydrating the same page in the same browser. A native child whose prop the page
// changes kept it at its first value where it did not follow it: the rows of a constant list (chain), a prop of a child
// it did not link (chain), the same through a Provider specialised per call site (prov), and a key printed once through
// a forwarder's spread (more), all of them through a static wrapper too (static), a prop that lands in a child's rest handed to a static child (rest), the same through a wrapper passing its own prop (restup), and a page's state object spread at the call site (spread). Those pages now fall back (`frozen-prop`) and render with React; a direct read stays
// native (direct). Every observable value equals React after each click.
// Run alone: `bun test --timeout 120000 tests/server/frozen-prop.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/frozen-prop/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/frozen-prop')
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

/** Tag, data-* attributes and leaf text of every element under <main>. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

async function run(page: string, react: boolean): Promise<{ log: string[]; errors: string[] }> {
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
  for (const id of ['f', 'box', 'f']) {
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

test('the pages that read a changing prop where it would not be followed render with React; a direct read stays native', () => {
  expect({ chain: tierOf('pChain_'), prov: tierOf('pProv_'), more: tierOf('pMore_'), static: tierOf('pStatic_'), rest: tierOf('pRest_'), restup: tierOf('pRestup_'), spread: tierOf('pSpread_'), direct: tierOf('pDirect_') }).toEqual({ chain: 'react', prov: 'react', more: 'react', static: 'react', rest: 'react', restup: 'react', spread: 'react', direct: 'native' })
})

for (const page of ['chain', 'prov', 'more', 'static', 'rest', 'restup', 'spread', 'direct']) {
  test(`${page}: every observable value equals React hydrating the same page after each click`, async () => {
    const react = await run(page, true)
    const served = await run(page, false)
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
