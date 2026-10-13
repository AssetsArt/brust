// tests/server/devtools.chromium.test.ts — `<brust-devtools>` (L15) in real Chromium, against a real `brust dev` and a real `brust start`.
// Run alone: `bun test --timeout 180000 tests/server/devtools.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const host = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let app = ''
let base = ''
let proc: ReturnType<typeof Bun.spawn>
let startProc: ReturnType<typeof Bun.spawn> | undefined
let startBase = ''
let browser: Browser
let log = ''

const files: Record<string, string> = {
  'routes.tsx': `import { defineRoutes } from '@brust/core/routes'
import Layout from './pages/Layout'
import Counter from './pages/Counter'
import Island from './pages/Island'
import Item from './pages/Item'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/counter', Component: Counter },
      { path: '/island', Component: Island },
      { path: '/item/{id}', Component: Item, loader: ({ params }) => ({ id: params.id }) },
    ],
  },
])
`,
  'lib.ts': `export const shout = (s: string) => s.toUpperCase() + '!'\n`,
  'pages/Layout.tsx': `import { Outlet } from '@brust/core/routes'
export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>t</title></head>
      <body>
        <nav><a href="/counter" data-testid="nav-link">counter</a></nav>
        <main data-testid="main"><Outlet /></main>
      </body>
    </html>
  )
}
`,
  'pages/Counter.tsx': `import { useState } from 'react'
export default function Counter() {
  const [n, setN] = useState(0)
  return <button type="button" data-testid="inc" onClick={() => setN(n + 1)}>n {n}</button>
}
`,
  'pages/Island.tsx': `import { useReducer } from 'react'
export default function Island() {
  const [n, inc] = useReducer((x: number) => x + 1, 0)
  return <button type="button" data-testid="rb" onClick={inc}>r {n}</button>
}
`,
  'pages/Item.tsx': `import { shout } from '../lib'
export default function Item({ id }: { id: string }) {
  return <h1 data-testid="t">{shout(id)}</h1>
}
`,
  'brust.toml': '',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function eventually<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeout = 30_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    let v: T | undefined | false
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}\n${log}`)
    await sleep(100)
  }
}
const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = s.port as number
  s.stop(true)
  return p
}
const shadow = (page: Page, sel: string) => page.locator(`brust-devtools ${sel}`)

async function openPanel(page: Page, path: string) {
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await shadow(page, '.ind').waitFor({ timeout: 15_000 })
  await eventually(async () => (await shadow(page, '.ind').getAttribute('data-state')) === 'ready', 'the indicator to report the build state')
}

beforeAll(async () => {
  app = mkdtempSync(join(host, '.devtest-ui-'))
  mkdirSync(join(app, 'pages'))
  for (const [f, s] of Object.entries(files)) writeFileSync(join(app, f), s)
  const port = freePort()
  proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'development', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  for (const st of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of st) log += dec.decode(c, { stream: true })
    })()
  }
  base = `http://localhost:${port}`
  await eventually(() => /\[brust\] ready \S+ gen 1/.test(log), 'the first build')
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  for (const p of [proc, startProc]) {
    if (p && p.exitCode === null) {
      p.kill('SIGINT')
      if ((await Promise.race([p.exited, sleep(8000).then(() => undefined)])) === undefined) p.kill('SIGKILL')
    }
  }
  rmSync(app, { recursive: true, force: true })
})

test('the indicator appears in dev with the build state and the tier counts of the page; Alt+Shift+B toggles the panel', async () => {
  const page = await browser.newPage()
  await openPanel(page, '/counter')
  const text = (await shadow(page, '.ind').textContent())?.trim() ?? ''
  expect(text).toMatch(/^ready · \d+s \d+n \d+r$/)
  const meta = (await (await fetch(`${base}/_brust/dev/meta`)).json()) as { components: Record<string, { tier: string }> }
  const trace = await page.evaluate(() => JSON.parse(document.getElementById('__brust_trace')?.textContent ?? 'null'))
  const want = { static: 0, native: 0, react: 0 } as Record<string, number>
  for (const id of trace.rendered) want[meta.components[id]?.tier as string]++
  expect(text).toBe(`ready · ${want.static}s ${want.native}n ${want.react}r`)
  expect(await shadow(page, '.panel').isHidden()).toBe(true)
  await page.keyboard.press('Alt+Shift+B')
  await shadow(page, '.panel').waitFor({ state: 'visible' })
  await page.keyboard.press('Alt+Shift+B')
  await shadow(page, '.panel').waitFor({ state: 'hidden' })
  await page.close()
}, 60_000)

test('it is dev-only: `brust start` serves no <brust-devtools> and no devtools bundle', async () => {
  const out = join(app, '.start-dist')
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.exitCode, b.stderr.toString()).toBe(0)
  startProc = Bun.spawn([bin, 'start', '--dist-dir', out, '--entry', join(app, 'routes.tsx'), '--port', '0', '--workers', '1'], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_DIST_DIR: '', BRUST_APP_ENTRY: '', NODE_ENV: 'production', BRUST_DEV_TOKEN: '' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = (startProc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let o = ''
  while (!/\[brust\] ready/.test(o)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${o}`)
    o += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  startBase = `http://${/listening on (\S+)/.exec(o)?.[1]}`
  const page = await browser.newPage()
  await page.goto(`${startBase}/counter`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="inc"]').waitFor()
  await sleep(500)
  expect(await page.locator('brust-devtools').count()).toBe(0)
  expect(await page.evaluate(() => customElements.get('brust-devtools') === undefined)).toBe(true)
  expect(await page.content()).not.toContain('devtools.js')
  expect((await fetch(`${startBase}/_brust/dev/devtools.js`)).status).toBe(404)
  await page.close()
  rmSync(out, { recursive: true, force: true })
}, 120_000)

test('the Components panel lists the tiers the manifest says (static layout, native page, react island, static item with a job)', async () => {
  const out = join(app, '.manifest-dist')
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out, '--dev'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.exitCode, b.stderr.toString()).toBe(0)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { routes: { pattern: string; chain: string[] }[]; components: Record<string, { tier: string }> }
  const page = await browser.newPage()
  for (const path of ['/counter', '/island', '/item/abc']) {
    await openPanel(page, path)
    await shadow(page, '.ind').click()
    await shadow(page, '[role=tab]:has-text("Components")').click()
    const rows = await page.evaluate(() =>
      [...(document.querySelector('brust-devtools')?.shadowRoot?.querySelectorAll('.node') ?? [])].map((n) => ({ id: n.getAttribute('data-component') as string, badge: n.querySelector('.b')?.textContent as string })),
    )
    const trace = await page.evaluate(() => JSON.parse(document.getElementById('__brust_trace')?.textContent ?? 'null'))
    const route = manifest.routes.find((r) => r.pattern === trace.route.pattern)
    expect(route, path).toBeDefined()
    expect(rows.map((r) => r.id).sort()).toEqual([...new Set<string>(trace.rendered)].sort())
    for (const r of rows) expect([path, r.id, r.badge]).toEqual([path, r.id, manifest.components[r.id]?.tier as string])
    for (const id of route?.chain ?? []) expect(rows.some((r) => r.id === id), `${path}: chain level ${id}`).toBe(true)
  }
  // a react component shows its reason and the diagnostic location
  await openPanel(page, '/island')
  await shadow(page, '.ind').click()
  await shadow(page, '[role=tab]:has-text("Components")').click()
  const reactNode = shadow(page, '.node:has(.b.react)').first()
  expect(await reactNode.textContent()).toMatch(/reason: \S/)
  expect(await reactNode.textContent()).toMatch(/Island\.tsx:\d+:\d+ \S+/)
  await page.close()
  rmSync(out, { recursive: true, force: true })
}, 120_000)

test('hovering a static chain level highlights it on the page (chain markers via Range.getBoundingClientRect)', async () => {
  const page = await browser.newPage()
  await page.setViewportSize({ width: 900, height: 700 })
  await openPanel(page, '/item/abc')
  await shadow(page, '.ind').click()
  await shadow(page, '[role=tab]:has-text("Components")').click()
  const trace = await page.evaluate(() => JSON.parse(document.getElementById('__brust_trace')?.textContent ?? 'null'))
  const layoutId = trace.route.chain[0] as string
  // the expected box: the Range between the layout's markers, computed independently in the page
  const expected = await page.evaluate((id) => {
    const w = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT)
    let open: Comment | null = null
    let depth = 0
    for (let n = w.nextNode() as Comment | null; n; n = w.nextNode() as Comment | null) {
      const v = n.nodeValue ?? ''
      if (!open) { if (v === `brust:${id}`) { open = n; depth = 1 } continue }
      if (v.startsWith('brust:')) depth++
      else if (v === '/brust' && --depth === 0) {
        const r = document.createRange(); r.setStartAfter(open); r.setEndBefore(n)
        const b = r.getBoundingClientRect()
        return { left: b.left, top: b.top, width: b.width, height: b.height }
      }
    }
    return null
  }, layoutId)
  expect(expected).not.toBeNull()
  expect(await shadow(page, '.hl').isHidden()).toBe(true)
  await shadow(page, `.node[data-component="${layoutId}"]`).hover()
  await shadow(page, '.hl').waitFor({ state: 'visible' })
  const box = await shadow(page, '.hl').boundingBox()
  expect(Math.abs((box?.width ?? 0) - (expected?.width ?? -1))).toBeLessThan(6) // + the 2px border each side
  expect(Math.abs((box?.height ?? 0) - (expected?.height ?? -1))).toBeLessThan(6)
  await page.mouse.move(2, 2)
  await shadow(page, '.hl').waitFor({ state: 'hidden' })
  await page.close()
}, 60_000)

test('keyboard only: Alt+Shift+B opens with focus in the tabs, arrows move between tabs, Esc closes and restores focus', async () => {
  const page = await browser.newPage()
  await openPanel(page, '/counter')
  await page.locator('[data-testid="nav-link"]').focus()
  await page.keyboard.press('Alt+Shift+B')
  await shadow(page, '.panel').waitFor({ state: 'visible' })
  expect(await shadow(page, '[role=tab][aria-selected=true]').textContent()).toBe('Page')
  expect(await page.evaluate(() => document.querySelector('brust-devtools')?.shadowRoot?.activeElement?.getAttribute('role'))).toBe('tab')
  const order = ['Page', 'Components', 'Jobs', 'Store', 'Islands', 'Build', 'Requests']
  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press('ArrowRight')
    expect(await shadow(page, '[role=tab][aria-selected=true]').textContent()).toBe(order[i])
  }
  await page.keyboard.press('ArrowRight') // wraps
  expect(await shadow(page, '[role=tab][aria-selected=true]').textContent()).toBe('Page')
  await page.keyboard.press('End')
  expect(await shadow(page, '[role=tab][aria-selected=true]').textContent()).toBe('Requests')
  // roles and names
  expect(await shadow(page, '.panel').getAttribute('role')).toBe('dialog')
  expect(await shadow(page, '[role=tablist]').getAttribute('aria-label')).toBeTruthy()
  expect(await shadow(page, '[role=tabpanel]').getAttribute('aria-labelledby')).toBe('tab-Requests')
  await page.keyboard.press('Escape')
  await shadow(page, '.panel').waitFor({ state: 'hidden' })
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('nav-link')
  // the indicator is a real button reachable by Tab, and Enter opens
  await shadow(page, '.ind').focus()
  await page.keyboard.press('Enter')
  await shadow(page, '.panel').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.querySelector('brust-devtools')?.shadowRoot?.activeElement?.className)).toBe('ind')
  await page.close()
}, 60_000)

test('Jobs, Islands, Page and Requests panels show only what the trace, the DOM and the dev global hold', async () => {
  const page = await browser.newPage()
  await openPanel(page, '/item/xyz')
  await shadow(page, '.ind').click()
  const panel = async (tab: string) => {
    await shadow(page, `[role=tab]:has-text("${tab}")`).click()
    return (await shadow(page, '[role=tabpanel]').textContent()) ?? ''
  }
  const page1 = await panel('Page')
  expect(page1).toContain('/item/{id}')
  expect(page1).toContain('id=xyz')
  expect(page1).toMatch(/cache\s*(MISS|HIT|none)/)
  expect(page1).toMatch(/loader\s*[\d.]+ ms/)
  const jobs = await panel('Jobs')
  expect(jobs).toContain('precompute')
  expect(jobs).toMatch(/miss|hit/)
  expect(await panel('Store')).toContain('No stores on this page.')
  expect(await panel('Islands')).toContain('No React islands on this page.')
  expect(await panel('Build')).toContain('build: ready')
  expect(await panel('Requests')).toContain('GET /item/xyz')
  await page.close()
  const isl = await browser.newPage()
  await openPanel(isl, '/island')
  await isl.locator('brust-island[data-hydrated="1"]').waitFor({ state: 'attached', timeout: 15_000 })
  await shadow(isl, '.ind').click()
  await shadow(isl, '[role=tab]:has-text("Islands")').click()
  expect(await shadow(isl, '[role=tabpanel]').textContent()).toMatch(/island_\w+\s*yes/)
  await isl.close()
}, 60_000)

test('contrast of the indicator, the text and the tier badges is at least 4.5:1 in light and dark', async () => {
  const page = await browser.newPage()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await openPanel(page, '/island')
    await shadow(page, '.ind').click()
    await shadow(page, '[role=tab]:has-text("Components")').click()
    const pairs = await page.evaluate(() => {
      const root = document.querySelector('brust-devtools')?.shadowRoot as ShadowRoot
      const rgb = (s: string) => (/rgba?\((\d+), (\d+), (\d+)/.exec(s)?.slice(1, 4).map(Number) ?? [0, 0, 0]) as [number, number, number]
      const bgOf = (e: Element): [number, number, number] => {
        for (let n: Element | null = e; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor
          if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return rgb(c)
        }
        return [255, 255, 255]
      }
      const sel = ['.ind', '.tab[aria-selected="true"]', '.tab', '.body', '.node .muted', '.b.static, .b.native, .b.react', '.warn']
      return sel.flatMap((s) => {
        const e = root.querySelector(s)
        return e ? [{ s, fg: rgb(getComputedStyle(e).color), bg: bgOf(e) }] : []
      })
    })
    expect(pairs.length).toBeGreaterThanOrEqual(5)
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => { const s = (v as number) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
    }
    for (const p of pairs) {
      const [hi, lo] = [lum(p.fg), lum(p.bg)].sort((a, b) => b - a) as [number, number]
      expect([scheme, p.s, (hi + 0.05) / (lo + 0.05) >= 4.5]).toEqual([scheme, p.s, true])
    }
  }
  await page.close()
}, 90_000)
