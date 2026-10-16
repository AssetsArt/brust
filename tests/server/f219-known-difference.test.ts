// F219 / F230 (lead ruling: option C). A module that changes another app module's exported objects when it loads
// (`import './f219/patch'`: LABELS.a = 'patched', list.push('y')) was not seen: brust read B's exports as declared and
// served "one x" where React renders "patched x,y" (pinned here as a known difference until F230). The build now scans
// every app module once (`scanAppWrites`), and a component whose compiled code reads a written export renders with
// React (`module-written`), so served == React. Cases: the writer imported by the page (F219's own repro), by the
// routes entry, by a layout, and by another route; a module that is only read stays compiled; a write inside a
// function nothing calls is refused too (the scan does not prove "not at load": documented over-refusal).
// Run alone: `bun test --timeout 120000 tests/server/f219-known-difference.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/f219-routes.tsx'
const OUT = '.rows/dist-f219'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let buildLog = ''

const ROUTES = `import { defineRoutes } from "@brust/core/routes"
import "../repro/f230/patch-e"
import "../repro/f230/setup-secret"
import Page from "../repro/f219-page"
import PageE from "../repro/f230/Reade"
import Layout from "../repro/f230/Layout"
import PageL from "../repro/f230/Readl"
import Other from "../repro/f230/Other"
import PageR from "../repro/f230/Readr"
import PageO from "../repro/f230/Reado"
import PageF from "../repro/f230/Readf"
export const routes = defineRoutes([
  { path: "/f219", Component: Page },
  { path: "/e", Component: PageE },
  { Component: Layout, children: [{ path: "/l", Component: PageL }] },
  { path: "/other", Component: Other },
  { path: "/r", Component: PageR },
  { path: "/o", Component: PageO },
  { path: "/f", Component: PageF },
])
`

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), ROUTES)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', OUT], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  buildLog = b.stdout.toString() + b.stderr.toString()
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${buildLog}`)
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
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})

const text = (html: string, id: string) =>
  new RegExp(`<p[^>]*data-testid="${id}"[^>]*>(.*?)</p>`, 's').exec(html)?.[1].replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** React's own render of each page, after the server's modules loaded (the routes entry imports every route). */
function reactRenders(): Record<string, string> {
  const script = join(FIXTURE, '.rows/f219-react.tsx')
  writeFileSync(
    script,
    `import { renderToString } from 'react-dom/server'
import './f219-routes'
import Page from '../repro/f219-page'
import PageE from '../repro/f230/Reade'
import PageL from '../repro/f230/Readl'
import PageR from '../repro/f230/Readr'
import PageO from '../repro/f230/Reado'
import PageF from '../repro/f230/Readf'
const pages = { '/f219': Page, '/e': PageE, '/l': PageL, '/r': PageR, '/o': PageO, '/f': PageF }
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(pages).map(([k, P]) => [k, renderToString(<P />)]))))
`,
  )
  const r = Bun.spawnSync([process.execPath, script], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

const CASES: [string, string, string][] = [
  ['/f219', 'the page imports the writer (F219)', 'patched x,y'],
  ['/e', 'the routes entry imports the writer', 'patched x,y'],
  ['/l', 'a layout imports the writer', 'patched x,y'],
  ['/r', 'another route imports the writer', 'patched x,y'],
  ['/o', 'nothing writes the module', 'one x'],
  ['/f', 'the write sits in a function nothing calls', 'one x'],
]

test('served == React for a module another module writes when it loads', async () => {
  const react = reactRenders()
  for (const [path, label, want] of CASES) {
    expect([label, text(react[path]!, 'p')]).toEqual([label, want])
    expect([label, text(react[path]!, 'q')]).toEqual([label, `${want} 0`])
    const served = await (await fetch(`${base}${path}`)).text()
    expect([label, text(served, 'p')]).toEqual([label, want])
    expect([label, text(served, 'q')]).toEqual([label, `${want} 0`])
  }
})

test('a written module makes its readers fall back (named); a module only read stays compiled', async () => {
  for (const f of ['f219/labels.ts', 'f230/labels-e.ts', 'f230/labels-l.ts', 'f230/labels-r.ts', 'f230/labels-f.ts'])
    expect([f, buildLog.includes('module-written') && buildLog.includes(f)]).toEqual([f, true])
  expect(buildLog.includes('f230/labels-o.ts')).toBe(false)
  // The only-read case keeps its native component (directives, no React island host).
  const o = await (await fetch(`${base}/o`)).text()
  expect(o).toContain('x-data=')
  expect(o).not.toContain('<brust-island')
  const e = await (await fetch(`${base}/e`)).text()
  expect(e).toContain('<brust-island')
})

test('Mellow F1: a writer ships only to the islands whose code imports the module it writes, with a warning', () => {
  const pairs = [...buildLog.matchAll(/load-writer-in-client (\S+) is imported into the browser chunk of the React island (\S+):/g)].map((m) => `${m[1]} -> ${m[2]!.replace(/_[0-9a-f]{8}$/, '')}`)
  expect([...new Set(pairs)].sort()).toEqual([
    'repro/f219/patch.ts -> label',
    'repro/f219/patch.ts -> labelState',
    'repro/f230/patch-e.ts -> read',
    'repro/f230/patch-e.ts -> reade',
    'repro/f230/patch-l.ts -> read',
    'repro/f230/patch-l.ts -> readl',
    'repro/f230/patch-r.ts -> read',
    'repro/f230/patch-r.ts -> readr',
  ])
  // The setup module writes a module no island reads: its code is in no browser file.
  const client = join(FIXTURE, OUT, 'client')
  const shipped = readdirSync(client, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => readFileSync(join(client, f), 'utf8').includes('SECRET-F230'))
  expect(shipped).toEqual([])
})

test('hydrated in Chromium: the islands keep React\'s values (the writers run in the island chunks too) and count', async () => {
  const browser = await chromium.launch()
  try {
    for (const [path, label, want] of CASES) {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      await page.goto(`${base}${path}`, { waitUntil: 'load' })
      await page.waitForTimeout(500)
      const q = page.getByTestId('q')
      await q.click()
      const now = (await q.textContent())?.replace(/\s+/g, ' ').trim()
      const p = (await page.getByTestId('p').textContent())?.replace(/\s+/g, ' ').trim()
      expect([label, p, now, errors]).toEqual([label, want, `${want} 1`, []])
      await page.close()
    }
  } finally {
    await browser.close()
  }
}, 120_000)
