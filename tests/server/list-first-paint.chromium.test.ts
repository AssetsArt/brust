// F412 (Assets Art B-10) in real Chromium, against React hydrating the same page in the same browser. A native `.map`
// whose rows are `hidden={…}` and whose shown row is not row 0 warned `first-paint mismatch x-text … "openat" vs
// "read"` and left a hidden copy of row 1 in the list: the binder took every row the server printed `hidden` for the
// zero-row template, so the shown row was adopted for row 0's key and the other hidden rows were never adopted nor
// removed. Fixed by F396 (the template is the element after the server's `<!--x-for-->` marker); this file pins it.
// Pages: the filed repro (index-picked), the same picked by name (noindex), keyed reorder and add after hydration
// (reorder), a row text reading the index (stepper), a child component in each hidden row (panel), and a list that
// starts empty (empty). Served (`brust start`) and static (`brust build --target static`) both equal React after each
// click, with a clean console and no `x-for` element left in `<main>`.
// Run alone: `bun test --timeout 120000 tests/server/list-first-paint.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/list-first-paint/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/list-first-paint')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const out = join(app, 'dist/static')
let proc: ReturnType<typeof Bun.spawn>
let files: ReturnType<typeof Bun.serve> | undefined
let base = ''
let staticBase = ''
let browser: Browser
let reactJs = ''

beforeAll(async () => {
  for (const args of [['build', 'routes.tsx'], ['build', 'routes.tsx', '--target', 'static']]) {
    const b = Bun.spawnSync([bin, ...args], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust ${args.join(' ')} failed:\n${b.stderr.toString()}`)
  }
  const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
  if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
  reactJs = await r.outputs[0]!.text()
  files = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/+/, '')
      const file = join(out, /\.\w+$/.test(path) ? path : `${path}.html`)
      return existsSync(file) ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
    },
  })
  staticBase = `http://127.0.0.1:${files.port}`
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  files?.stop()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** Tag, hidden, data-* attributes and leaf text of every element under <main>. brust's text holes (`<span x-text>`
 * with no other attribute, where React prints a bare text node) are text, not elements. */
const observe = (page: Page) =>
  page.evaluate(() => {
    const hole = (e: Element) => e.localName === 'span' && e.attributes.length === 1 && e.hasAttribute('x-text')
    return [...document.querySelectorAll('main *')].filter((e) => !hole(e)).map((e) => `${e.localName}${(e as HTMLElement).hidden ? '[hidden]' : ''}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${[...e.children].every(hole) ? e.textContent : ''}`).join(' ')
  })
const strays = (page: Page) => page.evaluate(() => document.querySelectorAll('main [x-for]').length)

const clicks: Record<string, string[]> = {
  repro: ['first'],
  noindex: ['first'],
  reorder: ['reverse', 'add', 'first', 'reverse'],
  stepper: ['first'],
  panel: ['first'],
  empty: ['add', 'add'],
}

async function run(page: string, how: 'react' | 'served' | 'static'): Promise<{ log: string[]; errors: string[]; strays: number }> {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  if (how === 'react') {
    await p.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root">${renderPage(page)}</div><script>window.__page = ${JSON.stringify(page)}</script><script src="/app.js"></script></body></html>` }),
    )
    await p.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  } else {
    await p.goto(`${how === 'served' ? base : staticBase}/${page}`, { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => document.querySelector('[x-data]') !== null)
  }
  await p.waitForTimeout(300)
  const left = how === 'react' ? 0 : await strays(p)
  const log = [await observe(p)]
  for (const id of clicks[page] ?? []) {
    await p.locator(`[data-testid="${id}"]`).click()
    await p.waitForTimeout(150)
    log.push(await observe(p))
  }
  await p.close()
  return { log, errors, strays: left }
}

for (const page of Object.keys(clicks)) {
  test(`${page}: served and static first paint and every click equal React, no warning, no row left behind`, async () => {
    const react = await run(page, 'react')
    expect(react.errors).toEqual([])
    for (const how of ['served', 'static'] as const) {
      const got = await run(page, how)
      expect({ how, errors: got.errors, strays: got.strays }).toEqual({ how, errors: [], strays: 0 })
      expect(got.log).toEqual(react.log)
    }
  }, 90_000)
}
