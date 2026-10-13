// tests/server/dev.chromium.test.ts — `brust dev` (L13) in real Chromium: what the user SEES after an edit, never a curl soak
// (post-mortem a2bf5e9: a curl soak passed while the browser got no client script, a lost reload frame, a crash).
// The pattern follows hydrate.chromium.test.ts: a `window.__noReload`-style marker proves whether the page was reloaded.
// Run alone: `bun test --timeout 180000 tests/server/dev.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

// A sub-directory of an existing workspace member, so `@brust/core`, `react` and `elysia` resolve from its node_modules.
const host = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let app = ''
let base = ''
let proc: ReturnType<typeof Bun.spawn>
let log = ''
let browser: Browser

const doc = (title: string, body: string, head = '') =>
  `<html lang="en"><head><meta charSet="utf-8" /><title>${title}</title>${head}</head><body>${body}</body></html>`

const homeSrc = (text: string) => `export default function Home() {
  return (
    ${doc('home', `<h1 data-testid="t">${text}</h1><p data-testid="swatch" className="swatch">swatch</p>`, '<link rel="stylesheet" href="/public/app.css" />')}
  )
}
`
const islandSrc = (text: string) => `import { useReducer } from 'react'
export default function Island() {
  const [n, inc] = useReducer((x: number) => x + 1, 0)
  return (
    ${doc('react', `<h1 data-testid="r">${text}</h1><button type="button" data-testid="rb" onClick={inc}>n {n}</button>`)}
  )
}
`
const routesSrc = (extra = '') => `import { defineRoutes } from '@brust/core/routes'
import Home from './pages/Home'
import Island from './pages/Island'
import Boom from './pages/Boom'
${extra}
export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/island', Component: Island },
  { path: '/boom', Component: Boom, loader: () => { throw new Error('boom') } },
])
`
const css = (color: string) => `.swatch { color: ${color}; }\n`
const write = (rel: string, s: string) => writeFileSync(join(app, rel), s)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function eventually<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeout = 30_000): Promise<T> {
  const t0 = Date.now()
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n--- dev log ---\n${log}`)
    await sleep(100)
  }
}
const text = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`).first().textContent({ timeout: 1000 })
const overlay = (page: Page) => page.locator('brust-dev-overlay').locator('[data-testid="brust-dev-overlay"]')
const marker = (page: Page) => page.evaluate(() => (window as unknown as { __m?: number }).__m)
async function open(path: string, ready = 't') {
  const page = await browser.newPage()
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-testid="${ready}"]`).waitFor({ timeout: 15_000 })
  await page.evaluate(() => {
    ;(window as unknown as { __m: number }).__m = 1
  })
  // the dev client connected: it only reloads/overlays through its socket, so wait until the server has seen it
  await sleep(300)
  return page
}
/** Wait for `[brust] ready ... gen N` with N >= `gen` in the dev log (plain mode prints one line per state change). */
const readyGen = (gen: number) =>
  eventually(() => {
    const all = [...log.matchAll(/\[brust\] ready \S+ gen (\d+)/g)].map((m) => Number(m[1]))
    return all.length > 0 && Math.max(...all) >= gen ? true : undefined
  }, `ready gen >= ${gen}`)

beforeAll(async () => {
  app = mkdtempSync(join(host, '.devtest-'))
  mkdirSync(join(app, 'pages'))
  mkdirSync(join(app, 'public'))
  write('routes.tsx', routesSrc())
  write('pages/Home.tsx', homeSrc('hello v1'))
  write('pages/Island.tsx', islandSrc('react v1'))
  write('pages/Boom.tsx', `export default function Boom() {\n  return ${doc('boom', '<h1>boom</h1>')}\n}\n`)
  write('public/app.css', css('rgb(255, 0, 0)'))
  write('brust.toml', '[actions]\nentry = "actions.ts"\n')
  write('actions.ts', `import { brust } from '@brust/core/elysia'\nimport { Elysia } from 'elysia'\nexport default new Elysia({ adapter: brust() }).post('/echo', () => ({ ok: true }))\n`)
  const port = (() => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const p = s.port as number
    s.stop(true)
    return p
  })()
  // stdout is a pipe, not a TTY: the TUI is in its plain line mode, which is what this test reads.
  proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'development', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of s) log += dec.decode(c, { stream: true })
    })()
  }
  base = `http://localhost:${port}`
  await readyGen(1)
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  if (proc && proc.exitCode === null) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, sleep(8000).then(() => undefined)])) === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  rmSync(app, { recursive: true, force: true })
})

test('a TSX edit reloads the page and shows the NEW text', async () => {
  const page = await open('/')
  expect(await text(page, 't')).toBe('hello v1')
  write('pages/Home.tsx', homeSrc('hello v2'))
  await eventually(async () => (await text(page, 't')) === 'hello v2', 'the new text after reload')
  expect(await marker(page)).toBeUndefined() // a reload happened: the marker is gone
  await page.close()
}, 90_000)

test('a CSS edit keeps the page (the marker survives) and applies the new style', async () => {
  const page = await open('/')
  const color = () => page.locator('[data-testid="swatch"]').evaluate((e) => getComputedStyle(e).color)
  expect(await color()).toBe('rgb(255, 0, 0)')
  write('public/app.css', css('rgb(0, 0, 255)'))
  await eventually(async () => (await color()) === 'rgb(0, 0, 255)', 'the new colour')
  expect(await marker(page)).toBe(1) // no reload
  await page.close()
}, 90_000)

test('a syntax error shows the overlay above the stale page, a page loaded meanwhile shows it too, and the fix recovers', async () => {
  const page = await open('/')
  const good = readFileSync(join(app, 'pages/Home.tsx'), 'utf8')
  write('pages/Home.tsx', `${good}\nconst = ;\n`)
  await eventually(async () => (await overlay(page).count()) > 0, 'the overlay')
  expect(await text(page, 't')).toBe('hello v2') // the stale page is still there
  expect(await overlay(page).textContent()).toContain('Home.tsx')
  expect(await marker(page)).toBe(1)
  // A page loaded while builds are failing shows the overlay too (catch-up from the server's state).
  const late = await browser.newPage()
  await late.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await eventually(async () => (await overlay(late).count()) > 0, 'the overlay on a page loaded during the error')
  // Fix: the overlay goes away and the page shows the fixed content.
  write('pages/Home.tsx', homeSrc('hello fixed'))
  await eventually(async () => (await text(page, 't')) === 'hello fixed', 'the recovered page')
  await eventually(async () => (await overlay(page).count()) === 0, 'the overlay to go away')
  await eventually(async () => (await text(late, 't')) === 'hello fixed', 'the late page to recover')
  await page.close()
  await late.close()
}, 120_000)

test('a boot error keeps the old child serving and shows the overlay; fixing it recovers', async () => {
  const page = await open('/')
  const before = await text(page, 't')
  // Build does not set BRUST_WORKER_ID, so only the booted worker imports this and throws.
  write('routes.tsx', routesSrc("if (process.env.BRUST_WORKER_ID !== undefined) throw new Error('worker import failed')"))
  await eventually(async () => (await overlay(page).count()) > 0, 'the boot error overlay', 60_000)
  expect(await overlay(page).textContent()).toContain('worker import failed')
  expect(await text(page, 't')).toBe(before)
  // The old child still answers requests through the proxy.
  const r = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
  expect(r.status).toBe(200)
  expect(await r.text()).toContain(before as string)
  write('routes.tsx', routesSrc())
  await eventually(async () => (await overlay(page).count()) === 0, 'recovery after the boot error', 60_000)
  await page.close()
}, 180_000)

test('two edits during one build both land', async () => {
  const home = await open('/')
  const island = await open('/island', 'r')
  write('pages/Home.tsx', homeSrc('home two-a'))
  await sleep(350) // past the debounce: the first build is running
  write('pages/Island.tsx', islandSrc('react two-b'))
  await eventually(async () => (await text(home, 't')) === 'home two-a', 'the first edit')
  await eventually(async () => (await text(island, 'r')) === 'react two-b', 'the second edit (made during the first build)')
  await home.close()
  await island.close()
}, 120_000)

test('native, react and 500 pages all carry the dev client script', async () => {
  for (const path of ['/', '/island', '/boom']) {
    const r = await fetch(`${base}${path}`, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } })
    const body = await r.text()
    expect([path, r.status === 500 ? 'boom' : 'ok']).toEqual([path, path === '/boom' ? 'boom' : 'ok'])
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatch(/<script type="module" src="\/_brust\/dev\/client\.js\?g=\d+"><\/script>/)
  }
  // In a browser too: the 500 page connects its client (a reload after an edit would reach it).
  const page = await browser.newPage()
  await page.goto(`${base}/boom`, { waitUntil: 'domcontentloaded' })
  expect(await page.locator('script[src^="/_brust/dev/client.js"]').count()).toBe(1)
  await page.close()
}, 60_000)

test('eight tabs at once all load and all reload on an edit (WebSocket, not one SSE connection each)', async () => {
  const ctx = await browser.newContext()
  const pages = await Promise.all(Array.from({ length: 8 }, async () => {
    const p = await ctx.newPage()
    await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    await p.locator('[data-testid="t"]').waitFor({ timeout: 15_000 })
    return p
  }))
  await sleep(500)
  write('pages/Home.tsx', homeSrc('eight tabs'))
  for (const p of pages) await eventually(async () => (await text(p, 't')) === 'eight tabs', 'every tab to reload')
  await ctx.close()
}, 120_000)

test('an action POST through the proxy passes the cross-site guard (Host and Origin are preserved)', async () => {
  const page = await open('/')
  const same = await page.evaluate(async () => (await fetch('/_brust/action/echo', { method: 'POST' })).status)
  expect(same).toBe(200)
  const cross = await fetch(`${base}/_brust/action/echo`, { method: 'POST', headers: { origin: 'https://evil.example' } })
  expect(cross.status).toBe(403)
  await page.close()
}, 60_000)

test('plain mode (stdout is not a TTY): line logs only, no escape codes, request lines with status and ms', async () => {
  await fetch(`${base}/`)
  expect(log).toContain('[brust] dev server on')
  expect(log).toMatch(/GET \/ 200 \d+ms/)
  expect(log).not.toContain('\x1b[')
})

test('Ctrl+C (SIGINT) quits cleanly: exit 0 and the generation directories are gone', async () => {
  expect(existsSync(join(app, '.brust/dev'))).toBe(true)
  proc.kill('SIGINT')
  expect(await Promise.race([proc.exited, sleep(15_000).then(() => 'timeout')])).toBe(0)
  expect(existsSync(join(app, '.brust/dev'))).toBe(false)
  await expect(fetch(`${base}/`)).rejects.toThrow() // the port is released
}, 60_000)
