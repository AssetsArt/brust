// tests/server/actions-standalone.chromium.test.ts — gaps round L16 (R16.5): two deployments, two origins, real
// Chromium. An actions-only server (`brust build --actions-only`, root prefix) on 127.0.0.1:<a> with
// `[cors] origins = ["http://localhost:<b>"]` + credentials, and a page-only server on localhost:<b> whose
// `[actions] base_url` points at it with `credentials = "include"`. A React island on the page calls the actions
// app cross-origin through `client()`; the cookie makes the round trip. Run alone:
// `bun test --timeout 180000 tests/server/actions-standalone.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const src = join(import.meta.dir, '../../packages/brust/test/fixtures/standalone')
const run = join(src, '.run')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

let browser: Browser
let api = ''
let pagesBase = ''
let pagesPort = 0
const procs: ReturnType<typeof Bun.spawn>[] = []

function sh(args: string[], cwd: string) {
  const r = Bun.spawnSync([bin, ...args], { cwd, env: { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_ACTIONS_BASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`brust ${args.join(' ')} failed:\n${r.stderr.toString()}${r.stdout.toString()}`)
}

async function start(cwd: string, port: number, host: string): Promise<void> {
  const p = Bun.spawn([bin, 'start', '--workers', '1'], { cwd, env: { ...process.env, BRUST_PORT: String(port), BRUST_ADDR: host, BRUST_ACTIONS_BASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' })
  procs.push(p)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://${host}:${port}/ping`)).ok) return
    } catch {}
    if (p.exitCode !== null) throw new Error(`brust start exited ${p.exitCode}:\n${await new Response(p.stderr).text()}`)
    await Bun.sleep(100)
  }
  throw new Error('brust start did not come up')
}

beforeAll(async () => {
  rmSync(run, { recursive: true, force: true })
  mkdirSync(run, { recursive: true })
  for (const d of ['api', 'pages']) cpSync(join(src, d), join(run, d), { recursive: true })
  const [a, b] = [await freePort(), await freePort()]
  pagesPort = b
  api = `http://127.0.0.1:${a}`
  pagesBase = `http://localhost:${b}`
  writeFileSync(join(run, 'api/brust.toml'), `[actions]\nentry = "actions.ts"\nprefix = "/"\n\n[cors]\norigins = ["${pagesBase}"]\ncredentials = true\n`)
  writeFileSync(join(run, 'pages/brust.toml'), `[actions]\nbase_url = "${api}"\nprefix = "/"\ncredentials = "include"\n`)
  sh(['build', '--actions-only'], join(run, 'api'))
  sh(['build', 'routes.tsx'], join(run, 'pages'))
  await start(join(run, 'api'), a, '127.0.0.1')
  await start(join(run, 'pages'), b, 'localhost')
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  for (const p of procs) p.kill('SIGINT')
  await Promise.all(procs.map((p) => Promise.race([p.exited, Bun.sleep(5000)])))
  rmSync(run, { recursive: true, force: true })
})

test('R16.5: a page action on another origin succeeds with a cookie round trip (base_url + credentials = include)', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(pagesBase, { waitUntil: 'domcontentloaded' })
  const html = await page.content()
  expect(html).toContain(`globalThis.__BRUST_ACTION_BASE__="${api}"`)
  expect(html).toContain('globalThis.__BRUST_ACTION_CREDENTIALS__="include"')
  await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
  await page.getByTestId('load').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="out"]')?.textContent === '{"team":null}', undefined, { timeout: 8000 })
  await page.getByTestId('save').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="out"]')?.textContent === '{"saved":"ash"}', undefined, { timeout: 8000 })
  // The cookie set by the other origin comes back: a credentialed GET sees it.
  await page.getByTestId('load').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="out"]')?.textContent === '{"team":"ash"}', undefined, { timeout: 8000 })
  expect(errors).toEqual([])
  await page.close()
})

test('R16.5: an unlisted origin is 403 CrossSiteRejected; the listed one is let through', async () => {
  const body = JSON.stringify({ name: 'x' })
  const headers = { 'content-type': 'application/json' }
  const bad = await fetch(`${api}/team`, { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body })
  expect(bad.status).toBe(403)
  expect(((await bad.json()) as { title: string }).title).toBe('CrossSiteRejected')
  const ok = await fetch(`${api}/team`, { method: 'POST', headers: { ...headers, origin: pagesBase }, body })
  expect(ok.status).toBe(200)
  expect(ok.headers.get('access-control-allow-origin')).toBe(pagesBase)
  expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
})

test('R16.5: the preflight answers 204 with the CORS headers', async () => {
  const r = await fetch(`${api}/team`, { method: 'OPTIONS', headers: { origin: pagesBase, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
  expect(r.status).toBe(204)
  expect(r.headers.get('access-control-allow-origin')).toBe(pagesBase)
  expect(r.headers.get('access-control-allow-credentials')).toBe('true')
  expect(r.headers.get('access-control-allow-methods')).toContain('POST')
})

test('R16.5/R16.4: the root prefix maps /team and /hello to the app as is; the page-only server mounts no local app', async () => {
  expect(await (await fetch(`${api}/hello`)).json()).toEqual({ hello: 'standalone' })
  expect((await fetch(`${api}/team`)).status).toBe(200)
  const local = await fetch(`${pagesBase}/_brust/action/hello`)
  expect(local.status).toBe(404)
  expect(pagesPort).toBeGreaterThan(0)
})
