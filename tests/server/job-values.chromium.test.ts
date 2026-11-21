// F585 in real Chromium: a job value JSON cannot carry (NaN, ±Infinity, -0, a bigint, 0n) prints as React prints it in
// every position (text, title, hidden, aria-hidden, data-*, a ternary test, a prop to a child, the items of an array),
// a reply holding a bigint is no longer a 500, and a component the client re-renders paints the same text first (no
// `first-paint mismatch`, no test flip) and after a state change.
// Run alone: `bun test --timeout 120000 tests/server/job-values.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { firstDifference, normalise } from '../../scripts/battery/ssr-normalise.ts'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/job-values')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const KEYS = ['nan', 'inf', 'ninf', 'negzero', 'big', 'zerobig', 'num']
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** The page's `<div>…</div>` root (the served document wraps it; React's render is it). */
const root = (html: string): string => {
  const at = html.indexOf('<div')
  const end = html.lastIndexOf('</div>')
  if (at < 0 || end < 0) throw new Error(`no root in ${html}`)
  return html.slice(at, end + '</div>'.length)
}

/** React's own render of every page, keyed `s/<k>` and `c/<k>` (one bun process, no JSON hop). */
const react = (): Record<string, string> => {
  const script = join(app, '.react-render.tsx')
  writeFileSync(
    script,
    `import { renderToString } from 'react-dom/server'\nimport Server from './Server'\nimport Client from './Client'\nconst out: Record<string, string> = {}\nfor (const k of ${JSON.stringify(KEYS)}) { out['s/' + k] = renderToString(<Server x={k} />); out['c/' + k] = renderToString(<Client x={k} />) }\nprocess.stdout.write(JSON.stringify(out))\n`,
  )
  const r = Bun.spawnSync([process.execPath, script], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

test('the served HTML equals React for every value and position', async () => {
  const want = react()
  const bad: string[] = []
  for (const path of Object.keys(want)) {
    const res = await fetch(`${base}/${path}`)
    expect(res.status).toBe(200)
    const diff = firstDifference(normalise(root(await res.text())), normalise(want[path]))
    if (diff !== null) bad.push(`${path}: ${JSON.stringify(diff)}`)
  }
  expect(bad).toEqual([])
}, 60_000)

test('the re-rendered component paints the same first, and after a state change', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /mismatch/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  const want: Record<string, [string, string]> = { nan: ['NaN', 'F'], inf: ['Infinity', 'T'], ninf: ['-Infinity', 'T'], negzero: ['0', 'F'], big: ['10', 'T'], zerobig: ['0', 'F'], num: ['42', 'T'] }
  for (const [k, [text, test]] of Object.entries(want)) {
    await page.goto(`${base}/c/${k}`, { waitUntil: 'load' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const seen = async () => [await page.getByTestId('text').textContent(), await page.getByTestId('text').getAttribute('title'), await page.getByTestId('test').textContent()]
    expect(await seen()).toEqual([text, text, test])
    await page.getByTestId('bump').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="bump"]')?.textContent === '1')
    expect(await seen()).toEqual([text, text, test])
  }
  expect(errors).toEqual([])
  await page.close()
}, 90_000)
