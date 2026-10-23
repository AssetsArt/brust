// F406 (Assets Art B-6) in real Chromium, against React hydrating the same page in the same browser. A list mapped
// inside a list row of a native component lost its inner list on the client (inner rows got `x-text` but no `x-for`:
// empty text, the first outer row's inner rows copied into the next one, a first-paint mismatch). Three pages: the filed
// repro (repro), an inner list that is state, reversed and added to (reorder), and an inner list that reads the outer
// item and index (outer). Every observable value equals React after each click, and the console stays clean (no
// `[brust] first-paint mismatch`).
// Run alone: `bun test --timeout 120000 tests/server/nested-list.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/nested-list/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/nested-list')
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

/** Tag, hidden, data-* attributes and leaf text of every element under <main>; brust's `display: contents` row wrapper
 * (`<brust-row>`, a row whose root is a condition) has no box and is not observed. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.localName !== 'brust-row').map((e) => `${e.localName}${(e as HTMLElement).hidden ? '[hidden]' : ''}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

const clicks: Record<string, string[]> = { repro: ['go'], reorder: ['go', 'add', 'go'], outer: ['go'] }

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
  for (const id of clicks[page] ?? []) {
    await p.locator(`[data-testid="${id}"]`).click()
    await p.waitForTimeout(150)
    log.push(await observe(p))
  }
  await p.close()
  return { log, errors }
}

for (const page of ['repro', 'reorder', 'outer']) {
  test(`${page}: first paint and every click equal React hydrating the same page, with a clean console`, async () => {
    const react = await run(page, true)
    const served = await run(page, false)
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
