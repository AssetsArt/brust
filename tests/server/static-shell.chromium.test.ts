// F524 in real Chromium: a page over loader data maps sections to a static wrapper (SectionView, a switch) whose arm renders
// a stateless wrapper (Custom) whose rows are a native-on-its-own Node (a switch over rows of Leaf). The fixed-props clone
// chain makes every level static: no runtime host, no hidden switch arm, no island; the first paint equals React's HTML.
// Run alone: `bun test --timeout 180000 tests/server/static-shell.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { firstDifference, normalise } from '../../scripts/battery/ssr-normalise'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/static-shell')
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

test('every component the page renders is static (the wrappers are fixed-props clones)', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const comps = Object.values(m.components as Record<string, { tier: string }>)
  expect(comps.length).toBeGreaterThan(0)
  expect(comps.filter((c) => c.tier !== 'static')).toEqual([])
})

test('first paint: the whole tree, no x-data, no hidden arm, no <brust-row>, no island', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const main = /<main>[\s\S]*<\/main>/.exec(html)![0]
  for (const id of ['s1', 'n1', 'l1', 'l2', 'n2', 'n3', 's3']) expect(main).toContain(`data-id="${id}"`)
  expect(main).toContain('<section id="s2" class="grid">')
  expect(main).not.toContain('x-data')
  expect(main).not.toContain(' hidden')
  expect(main).not.toContain('<brust-row')
  expect(main).not.toContain('<brust-island')
})

test("the first paint equals React's HTML for the same sections (ssr-compare normaliser)", async () => {
  const html = await (await fetch(`${base}/`)).text()
  const brust = /<main>[\s\S]*<\/main>/.exec(html)![0]
  const code = `import { renderToString } from 'react-dom/server'; import { createElement } from 'react'; import Page from './Page.tsx'; import { sections } from './data.ts'; process.stdout.write(renderToString(createElement(Page, { sections })))`
  const r = Bun.spawnSync([process.execPath, '-e', code], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  expect(firstDifference(normalise(brust), normalise(r.stdout.toString()))).toBeNull()
})

test('the page loads in a browser with no error', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    // The fixture's <img src="/n2.png"> has no file behind it: its 404 is the only expected console error.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  expect(await page.textContent('[data-id="l2"]')).toBe('two')
  expect(errors).toEqual([])
  await page.close()
})
