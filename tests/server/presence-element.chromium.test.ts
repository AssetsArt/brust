// F288 phase B in real Chromium, against React hydrating the same page in the same browser: `@radix-ui/react-presence`
// as published with an ELEMENT child (the checkbox / radio indicator shape), compiled native: the child mounts only
// while present, and Presence gets its node through the composed callback ref, which the runtime's `x-if` attaches
// with the branch and detaches before it leaves (`x-cref`). After every click the DOM equals React's; with an exit
// animation (`fade`, 400ms) the child stays until `animationend`, as in React; after 20 toggles every `animation*`
// listener Presence added is removed again, as in React; the console stays clean.
// Run alone: `bun test --timeout 120000 tests/server/presence-element.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderElement } from '../../packages/brust/test/fixtures/presence/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/presence')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let reactJs = ''
let reactHtml = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const r = await Bun.build({ entrypoints: [join(app, 'element-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
  if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
  reactJs = await r.outputs[0]!.text()
  reactHtml = await renderElement()
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

/** Counts `animation*` listeners added and removed on elements (Presence's own, on its node). */
const COUNT = `(() => {
  const w = window; w.__anim = { add: 0, remove: 0 }
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (t, ...a) { if (this instanceof Element && String(t).startsWith('animation')) w.__anim.add++; return add.call(this, t, ...a) }
  EventTarget.prototype.removeEventListener = function (t, ...a) { if (this instanceof Element && String(t).startsWith('animation')) w.__anim.remove++; return rem.call(this, t, ...a) }
})()`

/** Each section's panels: whether present in the document and their `data-*` state; brust's wrappers have no box. */
const shown = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section')].map((s) =>
      `${s.dataset.testid}:${[...s.querySelectorAll('[data-testid="panel"]')].map((p) => `${(p as HTMLElement).innerText}|${(p as HTMLElement).dataset.present}|${(p as HTMLElement).dataset.open}`).join(',')}`,
    ),
  )

async function open(how: 'react' | 'served'): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.addInitScript(COUNT)
  if (how === 'react') {
    await page.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root">${reactHtml}</div><script src="/app.js"></script></body></html>` }),
    )
    await page.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  } else {
    await page.goto(`${base}/element`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelector('[x-data]') !== null)
  }
  await page.waitForTimeout(200)
  return { page, errors }
}

/** Clicks the toggle and records the DOM right after, then once every animation has ended. */
async function timeline(page: Page, clicks: number): Promise<string[][]> {
  const log = [await shown(page)]
  for (let i = 0; i < clicks; i++) {
    await page.getByTestId('toggle').click()
    log.push(await shown(page))
    await page.waitForTimeout(600)
    log.push(await shown(page))
  }
  return log
}

test('served 200 with no React island; first paint and every toggle equal React, exit animation held to animationend', async () => {
  const res = await fetch(`${base}/element`)
  expect(res.status).toBe(200)
  expect(await res.text()).not.toContain('brust-island')
  const react = await open('react')
  const served = await open('served')
  const want = await timeline(react.page, 4)
  const got = await timeline(served.page, 4)
  // the closing click: `plain` leaves at once, `fade` stays in the document (open=n) until its animation ends
  expect(want[3]).toEqual(['plain:', 'fade:fade|n|n'])
  expect(want[4]).toEqual(['plain:', 'fade:'])
  expect(got).toEqual(want)
  expect(served.errors).toEqual([])
  expect(react.errors).toEqual([])
  await react.page.close()
  await served.page.close()
}, 90_000)

test('after 20 toggles every animation listener Presence added is removed again, and the DOM equals React', async () => {
  const counts: Record<string, { add: number; remove: number }> = {}
  const last: Record<string, string[]> = {}
  for (const how of ['react', 'served'] as const) {
    const { page, errors } = await open(how)
    for (let i = 0; i < 20; i++) {
      await page.getByTestId('toggle').click()
      await page.waitForTimeout(i % 2 ? 550 : 50)
    }
    counts[how] = await page.evaluate(() => (window as unknown as { __anim: { add: number; remove: number } }).__anim)
    last[how] = await shown(page)
    expect(errors).toEqual([])
    await page.close()
  }
  expect(last.served).toEqual(last.react!)
  expect(last.served).toEqual(['plain:', 'fade:'])
  // every node Presence watched was let go: each listener it added is removed. React's own add/remove counts are not
  // compared (they differ from brust's by a few adds on this toggle pattern, 66/60 against 60/60 when written).
  expect(counts.served!.add).toBeGreaterThan(0)
  expect(counts.served!.remove).toBe(counts.served!.add)
}, 120_000)
