// F234 in real Chromium: a native child's prop that the call site omits, or passes as `undefined`, takes its
// destructuring default as in React; an explicit `null` stays null. Before the fix the omitted prop was seeded into
// `x-props` as null, so the server painted the default (aria-expanded="false") and hydration dropped it. Each case is
// checked three ways: the served HTML, the DOM after hydration, and React's renderToString.
// Run alone: `bun test --timeout 120000 tests/server/absent-prop-seed.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/absent-prop-routes.tsx'
const OUT = '.rows/dist-absent-prop'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport Page from "../repro/absent-prop-page"\nexport const routes = defineRoutes([\n  { path: "/absent", Component: Page },\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', OUT], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', OUT, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
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
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})

// What a case shows: the button's aria-expanded (null when absent) and its text; Who's and Show's text.
type Shot = Record<string, { expanded: string | null; text: string }>
const IDS = ['omitted', 'undef', 'null', 'true', 'who', 'show']
const clean = (s: string) => s.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim()

function fromHtml(html: string): Shot {
  const out: Shot = {}
  for (const id of IDS) {
    const m = new RegExp(`<(button|b|i)([^>]*data-testid="${id}"[^>]*)>(.*?)</\\1>`, 's').exec(html)
    if (!m) throw new Error(`no ${id} in ${html}`)
    const ex = /(?:^|\s)aria-expanded="([^"]*)"/.exec(m[2])
    out[id] = { expanded: ex ? ex[1] : null, text: clean(m[3].replace(/<[^>]+>/g, '')) }
  }
  return out
}

let react = ''
beforeAll(() => {
  // React's own render, in the fixture app (its react / react-dom).
  const script = join(FIXTURE, '.rows/absent-prop-react.tsx')
  writeFileSync(script, `import { renderToString } from 'react-dom/server'\nimport Page from '../repro/absent-prop-page'\nprocess.stdout.write(renderToString(<Page />))\n`)
  const r = Bun.spawnSync([process.execPath, script], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  react = r.stdout.toString()
})

async function hydrated(page: import('playwright').Page): Promise<Shot> {
  return page.evaluate((ids) => {
    const out: Record<string, { expanded: string | null; text: string }> = {}
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`)!
      out[id] = { expanded: el.getAttribute('aria-expanded'), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() }
    }
    return out
  }, IDS)
}

test('server paint == hydrated DOM == React for omitted, undefined, null and given props', async () => {
  const want = fromHtml(react)
  expect(want.omitted).toEqual({ expanded: 'false', text: 'false' })
  expect(want.undef).toEqual({ expanded: 'false', text: 'false' })
  expect(want.null).toEqual({ expanded: null, text: 'null' })
  expect(want.true).toEqual({ expanded: 'true', text: 'true' })
  expect(want.who.text).toBe('dflt 0')
  expect(want.show.text).toBe('set ann')
  const served = fromHtml(await (await fetch(`${base}/absent`)).text())
  expect(served).toEqual(want)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/absent`, { waitUntil: 'load' })
  await page.waitForTimeout(500)
  expect(await hydrated(page)).toEqual(want)
  // The omitted default is live state: a click flips it as in React.
  await page.getByTestId('omitted').click()
  expect(await page.getByTestId('omitted').getAttribute('aria-expanded')).toBe('true')
  await page.getByTestId('who').click()
  expect((await page.getByTestId('who').textContent())?.replace(/\s+/g, ' ').trim()).toBe('dflt 1')
  expect(errors).toEqual([])
  await page.close()
})

test('a linked value turning undefined on the client takes the default again (x-props-bind)', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/absent`, { waitUntil: 'load' })
  await page.waitForTimeout(500)
  const show = async () => (await page.getByTestId('show').textContent())?.replace(/\s+/g, ' ').trim()
  expect(await show()).toBe('set ann')
  await page.getByTestId('flip').click()
  expect(await show()).toBe('dflt nobody')
  await page.getByTestId('flip').click()
  expect(await show()).toBe('set ann')
  expect(errors).toEqual([])
  await page.close()
})
