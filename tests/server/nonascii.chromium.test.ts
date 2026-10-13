// tests/server/nonascii.chromium.test.ts — L24: a route with a non-ASCII literal (`/ข่าว`, `/ข่าว/{id}`) answers on a real
// `brust start`: Chromium navigates to the Thai URL it percent-encodes, curl-style requests in both spellings answer 200,
// the L1 entry is shared, and an action's `cache.invalidate({ path })` with the Thai path removes it.
// Run alone: `bun test --timeout 180000 tests/server/nonascii.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

// A sub-directory of an existing workspace member, so `@brust/core`, `react` and `elysia` resolve from its node_modules.
const host = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const NEWS = '/ข่าว'
const NEWS_ENC = '/%E0%B8%82%E0%B9%88%E0%B8%B2%E0%B8%A7'
let app = ''
let base = ''
let proc: ReturnType<typeof Bun.spawn>
let browser: Browser

const page = (body: string) => `<html lang="th"><head><meta charSet="utf-8" /><title>ข่าว</title></head><body>${body}</body></html>`

beforeAll(async () => {
  app = mkdtempSync(join(host, '.devtest-nonascii-'))
  mkdirSync(join(app, 'pages'))
  writeFileSync(join(app, 'routes.tsx'), `import { defineRoutes } from '@brust/core/routes'
import News from './pages/News'
import Item from './pages/Item'

export const routes = defineRoutes([
  { path: '/ข่าว', Component: News, cache: { ttl_seconds: 60 } },
  { path: '/ข่าว/{id}', Component: Item, loader: ({ params }) => ({ id: params.id }) },
])
`)
  writeFileSync(join(app, 'pages/News.tsx'), `export default function News() {\n  return ${page('<h1 data-testid="t">ข่าวล่าสุด</h1>')}\n}\n`)
  writeFileSync(join(app, 'pages/Item.tsx'), `export default function Item({ id }: { id: string }) {\n  return ${page('<h1 data-testid="t">ข่าว {id}</h1>')}\n}\n`)
  writeFileSync(join(app, 'brust.toml'), '[actions]\nentry = "actions.ts"\n')
  writeFileSync(join(app, 'actions.ts'), `import { brust } from '@brust/core/elysia'
import { cache } from '@brust/core/server'
import { Elysia, t } from 'elysia'

export default new Elysia({ adapter: brust() }).post('/bump', { body: t.Object({ path: t.String() }) }, ({ body }) => cache.invalidate({ path: body.path }))
`)
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], {
    cwd: app,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)?.[1]}`
  void (async () => {
    for (;;) if ((await reader.read()).done) return
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
  rmSync(app, { recursive: true, force: true })
})

test('Chromium navigates to the Thai URL: 200 and the page content', async () => {
  const p = await browser.newPage()
  const res = await p.goto(`${base}${NEWS}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status()).toBe(200)
  expect(res?.url()).toContain(NEWS_ENC) // what Chromium sent
  expect(await p.locator('[data-testid="t"]').textContent()).toBe('ข่าวล่าสุด')
  await p.close()
}, 60_000)

test('a literal + param route: Chromium shows the decoded Thai param; %2F stays one param', async () => {
  const p = await browser.newPage()
  const res = await p.goto(`${base}${NEWS}/สวัสดี`, { waitUntil: 'domcontentloaded' })
  expect(res?.status()).toBe(200)
  expect(await p.locator('[data-testid="t"]').textContent()).toBe('ข่าว สวัสดี')
  await p.goto(`${base}${NEWS_ENC}/a%2Fb`, { waitUntil: 'domcontentloaded' })
  expect(await p.locator('[data-testid="t"]').textContent()).toBe('ข่าว a/b')
  await p.close()
}, 60_000)

test('encoded, lowercase-hex and raw-UTF-8 requests all answer 200 and share one cache entry; invalidating by the Thai path removes it', async () => {
  const cache = async (path: string) => {
    const r = await fetch(`${base}${path}`)
    expect(r.status).toBe(200)
    return r.headers.get('x-brust-cache')
  }
  const lower = NEWS_ENC.replace(/%E0/g, '%e0').replace(/%B8/g, '%b8')
  const bump = (path: string) => fetch(`${base}/_brust/action/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
  expect((await bump(NEWS_ENC)).status).toBe(200) // start from an empty entry (the Chromium tests above cached it); the encoded spelling works too
  expect(await cache(NEWS_ENC)).toBe('MISS')
  expect(await cache(NEWS_ENC)).toBe('HIT')
  expect(await cache(lower)).toBe('HIT')
  // fetch() encodes a raw Thai URL itself; a socket sends it verbatim (curl --path-as-is)
  const sock = await Bun.connect({ hostname: new URL(base).hostname, port: Number(new URL(base).port), socket: { data(_s, d) { raw += d.toString() }, close() {} } })
  let raw = ''
  sock.write(`GET ${NEWS} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
  for (let i = 0; i < 50 && !/\r\n\r\n/.test(raw); i++) await Bun.sleep(50)
  sock.end()
  expect(raw).toMatch(/^HTTP\/1\.1 200/)
  expect(raw.toLowerCase()).toContain('x-brust-cache: hit')
  // invalidate by the Thai path (the action posts it as the author wrote it)
  expect((await bump(NEWS)).status).toBe(200)
  expect(await cache(NEWS_ENC)).toBe('MISS')
}, 60_000)
