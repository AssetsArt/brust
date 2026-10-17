// F362 in real Chromium, against React hydrating the same page in the same browser. A module list the client rows run
// over (`const ITEMS = [{ id, name, secret }]`) ships only the keys the chunk reads: rows with a selection whose rows the
// client re-creates under a condition (rows), a host cloned in the rows (clone, F361 shape 1), a stateful child given a
// row value (child, shape 2). No script the page loads carries the unread `secret` (C2: every /_brust/*.js the page
// references, followed through its imports), and every observable value equals React after each click. A page handing
// the row value on whole (whole) ships the list as written (C1).
// Run alone: `bun test --timeout 120000 tests/server/module-projection.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/module-projection/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/module-projection')
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

/** Every script the page loads: each `/_brust/*.js` its HTML names, then each module those import (static, dynamic,
 * relative or absolute), fetched once. Returns url -> source. */
async function scripts(page: string): Promise<Map<string, string>> {
  const html = await (await fetch(`${base}/${page}`)).text()
  const seen = new Map<string, string>()
  const queue = [...html.matchAll(/["'(](\/_brust\/[^"')\s]+\.js)/g)].map((m) => new URL(m[1]!, base).href)
  while (queue.length) {
    const url = queue.pop()!
    if (seen.has(url)) continue
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const src = await res.text()
    seen.set(url, src)
    for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+\.js)["']/g)) queue.push(new URL(m[1]!, url).href)
  }
  return seen
}

/** Tag, data-* attributes and leaf text of every element under <main>; brust's `display: contents` wrappers have no box
 * and are not observed. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !['brust-row', 'brust-if', 'brust-host'].includes(e.localName)).map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

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

const tierOf = (prefix: string) => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  return Object.entries(m.components).find(([k]) => k.startsWith(prefix))![1].tier
}

test('every page is native', () => {
  expect({ rows: tierOf('pRows_'), clone: tierOf('pClone_'), child: tierOf('pChild_'), whole: tierOf('pWhole_') }).toEqual({ rows: 'native', clone: 'native', child: 'native', whole: 'native' })
})

for (const page of ['rows', 'clone', 'child']) {
  test(`${page}: no script the page loads carries the field the rows never read`, async () => {
    const all = await scripts(page)
    // the list itself ships (minified) with the key every page reads
    expect([...all.values()].some((s) => s.includes('{id:1'))).toBe(true)
    expect([...all.entries()].filter(([, s]) => s.includes('SECRET')).map(([u]) => u)).toEqual([])
    expect(await (await fetch(`${base}/${page}`)).text()).not.toContain('SECRET')
  })
}

test('whole: the row value handed on whole ships the list as written', async () => {
  const all = await scripts('whole')
  expect([...all.values()].some((s) => s.includes('SECRET_A'))).toBe(true)
})

const CLICKS: Record<string, string[]> = {
  // select, hide the rows, show them again (the client re-creates them from the projected list), select again
  rows: ['r2', 'open', 'open', 'r3', 'r1', 'open', 'open'],
  clone: ['f', 'b2', 'f', 'b3', 'b2'],
  child: ['f', 't1', 't3', 'f', 't1'],
  whole: ['r2', 'r1'],
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
