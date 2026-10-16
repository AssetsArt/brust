// `brust build --target static` end to end (gaps round L9) with the real CLI on test/fixtures/static-app:
// the layout under dist/static, byte-identical pages to `brust start` on the same dist, served the way
// Cloudflare Pages does (a path answers its file, <path>.html, or 404.html with status 404), and every
// refusal (R9.3-R9.5). Ported from the docs site's export test (git show 4ab7b15:website/test/export.test.ts);
// the Chromium half lives in tests/server/static.chromium.test.ts. Run alone: `bun test --timeout 300000 test/static.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = join(import.meta.dir, 'fixtures/static-app')
const bin = join(import.meta.dir, '../bin/brust')
const out = join(fixture, 'dist/static')
let pages: ReturnType<typeof Bun.serve> | undefined
let base = ''
let buildLog = ''
const copies: string[] = []

function build(cwd: string, ...args: string[]) {
  return buildEnv(cwd, {}, ...args)
}
function buildEnv(cwd: string, extra: Record<string, string>, ...args: string[]) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', ...extra } })
  return { code: b.exitCode, stdout: b.stdout.toString(), stderr: b.stderr.toString() }
}

/** A copy of the fixture inside the package (so `@brust/core` resolves), changed by `edit`. */
function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(import.meta.dir, `fixtures/.static-${name}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') })
  copies.push(dir)
  edit(dir)
  return dir
}

/** Pages' lookup for one path, or null for the 404 page. */
function resolve(pathname: string): string | null {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  for (const f of [rel, `${rel}.html`, rel === '' ? 'index.html' : null]) {
    if (f === null || f.includes('..')) continue
    const p = join(out, f)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

beforeAll(() => {
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  const b = build(fixture)
  if (b.code !== 0) throw new Error(`brust build --target static failed:\n${b.stderr}`)
  buildLog = b.stdout
  const redirects = readFileSync(join(out, '_redirects'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
  pages = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      // Pages matches a _redirects source against the decoded path.
      const path = new URL(req.url).pathname
      const r = redirects.find(([from]) => decodeURIComponent(from!) === decodeURIComponent(path))
      if (r) return new Response(null, { status: Number(r[2]), headers: { location: r[1]! } })
      const file = resolve(path)
      return file ? new Response(Bun.file(file)) : new Response(Bun.file(join(out, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  base = `http://127.0.0.1:${pages.port}`
}, 300_000)

afterAll(async () => {
  await pages?.stop(true)
  for (const d of [join(fixture, 'dist'), ...copies]) rmSync(d, { recursive: true, force: true })
})

test('layout: one file per page, 404.html, assets at their URL paths, _headers/_redirects/ssg.json, no server files', () => {
  const files = (dir: string, rel = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]))
  const all = files(out).sort()
  expect(all.filter((f) => f.endsWith('.html'))).toEqual(['404.html', 'docs.html', 'docs/intro.html', 'index.html', 'poke/100%.html', 'poke/pikachu.html', 'poke/ไทย.html', 'reads.html'])
  expect(all.filter((f) => !f.endsWith('.html')).map((f) => f.replace(/-[0-9a-f]{10}\.js$/, '.js'))).toEqual([
    '_brust/client/layout_255371d6.js',
    '_brust/client/react-counter_f1dc72be.js',
    '_brust/client/rt-basics.js',
    '_brust/client/rt-collection.js',
    '_brust/client/rt-for.js',
    '_brust/client/rt-html.js',
    '_brust/client/rt-if.js',
    '_brust/client/rt-island.js',
    '_brust/client/rt-model.js',
    '_brust/client/rt-store.js',
    '_brust/client/runtime.js',
    '_headers',
    '_redirects',
    'public/site.css',
    'ssg.json',
  ])
  for (const f of ['manifest.json', 'index.js', 'jobs.js', 'jinja']) expect([f, existsSync(join(out, f))]).toEqual([f, false])
  // the normal dist is still there for `brust start`
  for (const f of ['manifest.json', 'index.js', 'jobs.js', 'jinja']) expect([f, existsSync(join(fixture, 'dist', f))]).toEqual([f, true])
  expect(readFileSync(join(out, '_redirects'), 'utf8')).toBe('/old /docs 301\n/go/ไทย /docs/intro 302\n')
  expect(readFileSync(join(out, '_headers'), 'utf8')).toContain('/_brust/client/*\n  Cache-Control: public, max-age=31536000, immutable')
  const report = JSON.parse(readFileSync(join(out, 'ssg.json'), 'utf8'))
  expect(report.skipped).toEqual([{ routeId: 'r7', pattern: '/live/{id}' }])
  expect(report.notFound).toEqual({ file: '404.html', routeId: 'r9' })
  expect(report.redirects).toEqual([
    { from: '/old', to: '/docs', status: 301 },
    { from: `/go/${encodeURIComponent('ไทย')}`, to: '/docs/intro', status: 302 },
  ])
  expect(buildLog).toContain('[brust] static: 7 page(s), 2 redirect(s), 404.html, 1 route(s) ssg: false -> ')
  expect(buildLog).not.toContain('brust-tmp')
})

test('R9.5: a loader reading the request warns and the page is the no-cookie one', () => {
  expect(buildLog).toContain('[brust] warning ssg-request-read route r8 (/reads) reads req.cookies["theme"] (at /reads)')
  expect(readFileSync(join(out, 'reads.html'), 'utf8')).toContain('<p class="theme">none</p>')
})

test('every page is byte-identical to what brust start serves from the same dist', async () => {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: fixture, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  try {
    const live = `http://${/listening on (\S+)/.exec(log)![1]}`
    const report = JSON.parse(readFileSync(join(out, 'ssg.json'), 'utf8')) as { pages: { path: string; file: string }[] }
    for (const p of report.pages) {
      const r = await fetch(live + p.path, { headers: { 'accept-encoding': 'identity' } })
      expect([p.path, r.status, await r.text()]).toEqual([p.path, 200, readFileSync(join(out, p.file), 'utf8')])
    }
    const nf = await fetch(`${live}/nope`, { headers: { 'accept-encoding': 'identity' } })
    expect([nf.status, await nf.text()]).toEqual([404, readFileSync(join(out, '404.html'), 'utf8')])
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 60_000)

test('served like Pages: pages 200 (encoded paths too), the redirect 301, unknown paths the 404 page', async () => {
  for (const p of ['/', '/docs', '/docs/intro', '/poke/pikachu', '/poke/100%25', `/poke/${encodeURIComponent('ไทย')}`, '/reads']) expect([p, (await fetch(base + p)).status]).toEqual([p, 200])
  expect(await (await fetch(`${base}/poke/100%25`)).text()).toContain('<h1 class="poke">100%</h1>')
  const red = await fetch(`${base}/old`, { redirect: 'manual' })
  expect([red.status, red.headers.get('location')]).toEqual([301, '/docs'])
  const thai = await fetch(`${base}/go/${encodeURIComponent('ไทย')}`, { redirect: 'manual' })
  expect([thai.status, thai.headers.get('location')]).toEqual([302, '/docs/intro'])
  for (const p of ['/nope', '/live/1', '/poke/agumon']) {
    const r = await fetch(base + p)
    expect([p, r.status]).toEqual([p, 404])
    expect(await r.text()).toContain('<h1>Not found</h1>')
  }
})

test('--strict: a loader reading the request fails the build, and the previous dist is untouched', () => {
  const before = readFileSync(join(out, 'index.html'), 'utf8')
  const b = build(fixture, '--strict')
  expect(b.code).toBe(1)
  expect(b.stderr).toContain('error ssg-request-read route r8 (/reads) reads req.cookies["theme"]')
  expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe(before)
})

test('R9.4: a cache key that reads a cookie is ssg-varies; nothing is written ([actions] is test/static-actions.test.ts)', () => {
  const varies = variant('varies', (d) => {
    const src = readFileSync(join(d, 'routes.tsx'), 'utf8')
    writeFileSync(join(d, 'routes.tsx'), src.replace("{ path: '/', Component: Home }", "{ path: '/', Component: Home, cache: { ttl_seconds: 60, prefix: 'cookie(currency)' } }"))
  })
  const v = build(varies)
  expect(v.code).toBe(1)
  expect(v.stderr).toContain('error ssg-varies route r1 (/) cache.prefix reads cookie(currency)')
  expect(existsSync(join(varies, 'dist'))).toBe(false)
})

test('review N3: a page past BRUST_SSG_PAGE_TIMEOUT_MS, or a render past BRUST_SSG_TIMEOUT_MS, is ssg-timeout naming the path', () => {
  const slow = variant('slow', (d) => {
    const src = readFileSync(join(d, 'routes.tsx'), 'utf8')
    writeFileSync(join(d, 'routes.tsx'), src.replace("{ path: '/', Component: Home },", "{ path: '/', Component: Home },\n      { path: '/slow', Component: Home, loader: async () => { await Bun.sleep(20_000); return {} } },"))
  })
  const page = buildEnv(slow, { BRUST_SSG_PAGE_TIMEOUT_MS: '500' })
  expect([page.code, page.stderr.trim()]).toEqual([1, 'error ssg-timeout GET /slow did not answer within 500 ms (BRUST_SSG_PAGE_TIMEOUT_MS)'])
  expect(existsSync(join(slow, 'dist'))).toBe(false)
  const total = buildEnv(slow, { BRUST_SSG_TIMEOUT_MS: '4000' })
  expect([total.code, total.stderr.trim()]).toEqual([1, 'error ssg-timeout the render took longer than 4000 ms (BRUST_SSG_TIMEOUT_MS); it was rendering /slow'])
  expect(existsSync(join(slow, 'dist'))).toBe(false)
}, 120_000)

test('R9.3: a dynamic route without params fails; no * route writes a default 404.html with a warning', () => {
  const missing = variant('missing', (d) => {
    const src = readFileSync(join(d, 'routes.tsx'), 'utf8')
    writeFileSync(join(d, 'routes.tsx'), src.replace("{ path: '/live/{id}', Component: Home, ssg: false }", "{ path: '/live/{id}', Component: Home }"))
  })
  const m = build(missing)
  expect(m.code).toBe(1)
  expect(m.stderr).toContain("error ssg-params-missing route r7 (/live/{id}) is dynamic: add ssg: { params: () => [{ id: '…' }] } or ssg: false")
  const no404 = variant('no404', (d) => {
    const src = readFileSync(join(d, 'routes.tsx'), 'utf8')
    writeFileSync(join(d, 'routes.tsx'), src.replace("      { path: '*', Component: NotFound },\n", '').replace("import NotFound from './NotFound'\n", ''))
  })
  const n = build(no404)
  expect([n.code, n.stderr]).toEqual([0, ''])
  expect(n.stdout).toContain("[brust] warning ssg-404 no '*' route: wrote a default 404.html")
  expect(readFileSync(join(no404, 'dist/static/404.html'), 'utf8')).toContain('<h1>404 Not Found</h1>')
}, 120_000)
