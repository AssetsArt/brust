// F494 served: a stateless child a page feeds only loader data renders static at that call site. The page ships no script
// (no runtime, no rt-for, no React island) and its HTML equals React's render of the same tree with the same data. The
// same List under a stateful parent stays native: in Chromium its x-for adds a row on click.
// Run alone: `bun test --timeout 180000 tests/server/loader-static-tiers.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { reactHtml } from '../../packages/brust/test/fixtures/loader-static/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/loader-static')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let buildOut = ''

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  buildOut = b.stdout.toString() + b.stderr.toString()
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${buildOut}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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

type Comp = { tier: string }
const manifest = () => JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, Comp>; routes: { pattern: string; chain: string[] }[] }

for (const [path, page] of [['/list', 'list'], ['/prices', 'prices'], ['/sections', 'sections']] as const) {
  test(`${path}: static, no script, the same HTML as React`, async () => {
    const res = await fetch(base + path)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('x-data')
    expect(html).not.toContain('brust-island')
    expect(html).toBe(reactHtml(page))
    const m = manifest()
    const root = m.routes.find((r) => r.pattern === path)!.chain[0]!
    expect(m.components[root]!.tier).toBe('static')
  })
}

test('every fixed-props clone is static; the shared components keep their own tier', () => {
  const comps = Object.entries(manifest().components)
  const clones = comps.filter(([id]) => /_f[0-9a-f]{8}$/.test(id))
  expect(clones.map(([id]) => id.split('_')[0]).sort()).toEqual(['list', 'pageView', 'priceList'])
  for (const [, c] of clones) expect(c.tier).toBe('static')
  expect(comps.find(([id]) => /^list_[0-9a-f]+$/.test(id))![1].tier).toBe('native')
})

test('/stateful: the same List from a stateful parent stays native; its x-for adds a row on click', async () => {
  const html = await (await fetch(`${base}/stateful`)).text()
  expect(html).toContain('x-for=')
  expect(html).toContain('/_brust/client/rt-for-')
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(`${base}/stateful`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => document.querySelector('[x-data]') !== null)
  const titles = () => p.evaluate(() => [...document.querySelectorAll('h2.hero')].map((e) => e.textContent))
  expect(await titles()).toEqual(['A'])
  await p.click('button')
  await p.waitForFunction(() => document.querySelectorAll('h2.hero').length === 2)
  await p.click('button')
  await p.waitForFunction(() => document.querySelectorAll('h2.hero').length === 3)
  expect(await titles()).toEqual(['A', 'N1', 'N2'])
  expect(errors).toEqual([])
  await p.close()
})
