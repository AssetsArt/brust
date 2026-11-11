// F523 in real Chromium: a component that renders itself (NodeView, three group levels) is ONE template macro on the
// server (no React island per node), prints the whole tree on first paint, and a native leaf mounts at every level.
// C8: the same kind of tree compiled at runtime from source text (`compileComponent`) paints through a <Dynamic> slot exactly
// as the built route does.
// Run alone: `bun test --timeout 180000 tests/server/recursive.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { firstDifference, normalise } from '../../scripts/battery/ssr-normalise'
import { compileComponent } from '../../packages/brust/src/compile'
import { rcSource } from '../../packages/brust/test/fixtures/recursive/rcSource'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/recursive')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
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
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

test('the recursive component is static and each template holds at most one macro', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const comps = Object.values(m.components as Record<string, { tier: string; template: string }>)
  expect(comps.some((c) => c.tier === 'react')).toBe(false)
  const macros = comps.map((c) => readFileSync(join(app, 'dist', c.template), 'utf8').match(/\{%-? ?macro /g)?.length ?? 0)
  expect(Math.max(...macros)).toBe(1)
})

test('first paint holds the whole tree, no island', async () => {
  const html = await (await fetch(`${base}/`)).text()
  expect(html).not.toContain('<brust-island')
  for (const id of ['a', 'a1', 'b', 'c', 'c1', 'z']) expect(html).toContain(`data-id="${id}"`)
  expect(html).toMatch(/data-id="c"[\s\S]*data-id="c1"[^>]*>deep</)
})

test('the first paint equals React\'s HTML for the same tree (ssr-compare normaliser)', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const brust = /<main>[\s\S]*<\/main>/.exec(html)![0]
  // React resolves from the fixture app (packages/brust), not from the repo root.
  const code = `import { renderToString } from 'react-dom/server'; import { createElement } from 'react'; import Tree from './Tree.tsx'; import { tree } from './data.ts'; process.stdout.write(renderToString(createElement(Tree, { nodes: tree })))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  const react = r.stdout.toString()
  expect(firstDifference(normalise(brust), normalise(react))).toBeNull()
})

test('a native leaf mounts at every level', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  for (const label of ['A', 'B', 'C']) {
    await page.click(`[data-leaf="${label}"]`)
    await page.waitForFunction((l) => document.querySelector(`[data-leaf="${l}"]`)!.textContent === `${l} 1`, label)
  }
  expect(errors).toEqual([])
  await page.close()
})

test('C8: compileComponent turns a self-rendering source into one static artifact with one macro and the depth guard', async () => {
  expect(rcSource).toBe(readFileSync(join(app, 'StaticNode.tsx'), 'utf8'))
  const r = await compileComponent({ source: rcSource, filename: 'el/StaticNode.tsx', appRoot: app, dist: join(app, 'dist') })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  expect(r.artifact).toMatchObject({ tier: 'static', client: null, features: [] })
  expect(r.artifact.jinja.match(/\{%-? ?macro /g)?.length).toBe(1)
  expect(r.artifact.jinja).toContain('{{ recursion_limit("StaticNode", 32) }}')
})

test('C8: the runtime artifact through a <Dynamic> slot paints the 3-level tree exactly as the built route', async () => {
  const main = async (path: string) => {
    const r = await fetch(`${base}${path}`)
    expect(r.status).toBe(200)
    return /<main>[\s\S]*<\/main>/.exec(await r.text())![0]
  }
  const built = await main('/built')
  const slot = await main('/slot')
  expect(slot).not.toContain('<brust-island')
  for (const id of ['a', 'a1', 'b', 'c', 'c1', 'z']) expect(slot).toContain(`data-id="${id}"`)
  expect(slot).toMatch(/data-id="c"[\s\S]*data-id="c1"[^>]*>deep</)
  expect(firstDifference(normalise(slot), normalise(built))).toBeNull()
})

// F528: a route hands loader data to non-root components (PageView → SectionView → CustomSectionView → ElementView,
// which renders itself); fixed-props clones keep every level static instead of a React fallback.
test('F528: a recursive element under a props-fed section chain is static and equals React\'s HTML', async () => {
  const r = await fetch(`${base}/sections`)
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).not.toContain('<brust-island')
  expect(html).not.toContain('x-data')
  const brust = /<main>[\s\S]*<\/main>/.exec(html)![0]
  for (const id of ['s-hero', 's-custom', 'e-g1', 'e-t1', 'e-g2', 'e-img', 'e-deep', 'e-t2', 's-inline', 'i-g', 'i-t'])
    expect(brust).toContain(`data-id="${id}"`)
  const code = `import { renderToString } from 'react-dom/server'; import { createElement } from 'react'; import SectionsPage from './SectionsPage.tsx'; import { sectionsPage } from './data.ts'; process.stdout.write(renderToString(createElement(SectionsPage, { page: sectionsPage })))`
  const p = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  expect(firstDifference(normalise(brust), normalise(p.stdout.toString()))).toBeNull()
})
