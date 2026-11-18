// F552: a loader renders the route's page at any 4xx/5xx status with `renderStatus(status, data)`, as `notFound()` does
// at 404 (an app report: a 403 page redirected to `/`). Against packages/brust/test/fixtures/render-status served by
// `brust start`: the layout and its loader's data, the loader's header, never stored on a cached route, a native and a
// React-tier page; a client navigation to it is swapped in as a notFound page is.
// Run alone: `bun test --timeout 300000 tests/server/render-status.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/render-status')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let log = ''
let browser: Browser

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  const dec = new TextDecoder()
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c) })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; log += dec.decode(value) } })()
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const get = (path: string) => fetch(base + path, { redirect: 'manual' })

for (const [path, status, title, tier] of [
  ['/forbidden', 403, 'forbidden', 'native'],
  ['/down', 503, 'down', 'native'],
  ['/react-forbidden', 403, 'react-forbidden', 'react'],
] as const)
  test(`${tier} ${path}: the page and its layout at ${status}, the loader's data and header, never stored`, async () => {
    for (let i = 0; i < 2; i++) {
      const r = await get(path)
      expect(r.status).toBe(status)
      expect(r.headers.get('location')).toBeNull()
      expect(r.headers.get('x-brust-cache')).not.toBe('HIT')
      if (path !== '/down') expect(r.headers.get('x-why')).toBe('denied')
      const html = await r.text()
      expect(html).toContain('<p data-user="true">ann</p>')
      expect(html).toContain(`<h1>${title}</h1>`)
      expect(html).toContain(path === '/down' ? 'maintenance' : 'no access')
      // the React tier: the page is a server-rendered React island, not a native template
      if (tier === 'react') expect(html).toMatch(/<brust-island[^>]*>[\s\S]*data-tier="react"/)
    }
  })

test('control: the cached 200 page is stored (a second request is a HIT)', async () => {
  const seen: (string | null)[] = []
  for (let i = 0; i < 2; i++) seen.push((await get('/')).headers.get('x-brust-cache'))
  expect(seen).toEqual(['MISS', 'HIT'])
})

type NavEvent = { type: string; status?: number; swapped?: boolean }
declare global { interface Window { __navlog: NavEvent[]; __mark?: number } }

async function open(path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    window.__navlog = []
    for (const t of ['click', 'load', 'success', 'error'])
      document.addEventListener(`brust:nav:${t}`, (e) => {
        const d = (e as CustomEvent).detail
        window.__navlog.push({ type: t, status: d.status, swapped: d.swapped })
      })
  })
  await page.goto(base + path)
  await page.evaluate(() => { window.__mark = 1 })
  return { page, close: () => ctx.close() }
}

async function follow(page: Page, href: string): Promise<NavEvent[]> {
  const n = await page.evaluate(() => window.__navlog.length)
  await page.click(`nav a[href="${href}"]`)
  await page.waitForFunction((n) => window.__navlog.slice(n).some((e) => e.type === 'success' || e.type === 'error'), n)
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-brust-loading'))
  return page.evaluate((n) => window.__navlog.slice(n), n)
}

test('client navigation: a renderStatus page is swapped in as a notFound page is (error { status, swapped: true }, no full load)', async () => {
  const { page, close } = await open('/')
  for (const [href, status, title] of [
    ['/gone', 404, 'gone'],
    ['/forbidden', 403, 'forbidden'],
    ['/down', 503, 'down'],
    ['/react-forbidden', 403, 'react-forbidden'],
  ] as const) {
    const ev = await follow(page, href)
    expect(ev.at(-1)).toMatchObject({ type: 'error', status, swapped: true })
    expect(new URL(page.url()).pathname).toBe(href)
    expect(await page.textContent('h1')).toBe(title)
    expect(await page.textContent('[data-user]')).toBe('ann')
    // the same document: no full load happened
    expect(await page.evaluate(() => window.__mark)).toBe(1)
  }
  await close()
})
