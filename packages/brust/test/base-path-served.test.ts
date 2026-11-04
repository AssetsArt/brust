// F495 `[server] base_path`, from the outside: two apps share ONE origin. The root app has no base path; the portal app is
// built with `[server] base_path = "/portal"`. A path-routing proxy sends `/portal` and `/portal/*` to the portal app and
// everything else to the root app, with no rule about brust's own URLs (`/_brust/…`, `/public/…`, `/ping`) and no merged
// client dir: every URL each app prints already names the app it belongs to. Run alone:
// `bun test --timeout 300000 test/base-path-served.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const fixtures = join(import.meta.dir, 'fixtures')
const bin = join(import.meta.dir, '../bin/brust')
const root = join(fixtures, 'base-path-root')
const portal = join(fixtures, 'base-path-portal')
const bad = join(fixtures, 'base-path-bad')
const procs: ReturnType<typeof Bun.spawn>[] = []
let rootUrl = ''
let portalUrl = ''
let front: ReturnType<typeof Bun.serve> | undefined
let origin = ''

/** A shell-like env: none of the BRUST_* the test runner may carry. */
const shellEnv = () => {
  const { NODE_ENV: _n, ...rest } = process.env
  return { ...rest, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', CI: '' }
}

function build(app: string): { code: number; out: string } {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  return { code: b.exitCode, out: `${b.stderr.toString()}${b.stdout.toString()}` }
}

async function start(app: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  const dec = new TextDecoder()
  let log = ''
  void (async () => {
    for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c, { stream: true })
  })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  // Keep draining: a closed pipe would make the server's next println! panic.
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
  return `http://${/listening on (\S+)/.exec(out)![1]}`
}

beforeAll(async () => {
  for (const app of [root, portal]) {
    const b = build(app)
    if (b.code !== 0) throw new Error(`brust build failed in ${app}:\n${b.out}`)
  }
  rootUrl = await start(root)
  portalUrl = await start(portal)
  // The whole deployment's routing rule: one path prefix, nothing about brust's own URLs.
  front = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const target = url.pathname === '/portal' || url.pathname.startsWith('/portal/') ? portalUrl : rootUrl
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null
      const res = await fetch(`${target}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { ...Object.fromEntries(req.headers), 'accept-encoding': 'identity' },
        ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
        redirect: 'manual',
        // biome-ignore lint/suspicious/noExplicitAny: Bun's fetch option
      } as any)
      return new Response(res.body, { status: res.status, headers: res.headers })
    },
  })
  origin = `http://localhost:${front.port}`
}, 300_000)

afterAll(async () => {
  front?.stop(true)
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      p.kill('SIGKILL')
      await p.exited
    }
  }
  for (const app of [root, portal, bad]) rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const get = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init)
const text = async (path: string) => (await get(path)).text()
/** Every `src`/`href` of the page that names one of brust's own URLs (`/_brust/…`, `/public/…`, under any base). */
const brustUrls = (html: string): string[] =>
  [...html.matchAll(/(?:src|href)="([^"]*\/(?:_brust|public)\/[^"]*)"/g)].map((m) => m[1]!)

test('the root app is the build it always was: no base_path in the manifest, root-level URLs, no base marker', async () => {
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))
  expect('base_path' in manifest).toBe(false)
  expect(manifest.actions.prefix).toBe('/_brust/action')
  const html = await text('/')
  expect(html).toContain('root home')
  const urls = brustUrls(html)
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.every((u) => u.startsWith('/_brust/'))).toBe(true)
  expect(html).not.toContain('data-brust-base')
  expect(html).not.toContain('/portal/_brust/')
})

test('the portal app is built for its base path: the manifest says so and every URL it prints lies under it', async () => {
  const manifest = JSON.parse(readFileSync(join(portal, 'dist/manifest.json'), 'utf8'))
  expect(manifest.base_path).toBe('/portal')
  expect(manifest.actions.prefix).toBe('/portal/_brust/action')
  const html = await text('/portal')
  expect(html).toContain('portal home')
  const urls = brustUrls(html)
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.every((u) => u.startsWith('/portal/_brust/'))).toBe(true)
  expect(html).not.toMatch(/(?:src|href)="\/_brust\//)
  expect(html).toContain('data-brust-nav')
  expect(html).toContain('data-brust-base="/portal"')
  // the page tells the client its mount point (the actions client and `basePath` read it)
  expect(html).toContain('globalThis.__BRUST_BASE_PATH__="/portal"')
})

test('every asset of both apps resolves through the one proxy, with no client dir merged', async () => {
  for (const path of ['/', '/portal']) {
    const urls = brustUrls(await text(path)).filter((u) => /\.(?:js|css)$/.test(u))
    expect(urls.length).toBeGreaterThan(2)
    for (const u of urls) {
      const r = await get(u)
      expect(r.status, `${path} → ${u}`).toBe(200)
      expect(r.headers.get('content-type')).toMatch(/javascript|css/)
      await r.arrayBuffer()
    }
  }
  // No merge: a hashed file only one app built (its island chunk names that app's own runtime URL, so it differs) is served
  // under that app's URL and nowhere in the other's tree. (A file both apps built byte for byte, like the runtime, is in both.)
  const base = (u: string) => u.slice(u.lastIndexOf('/') + 1)
  const rootFiles = brustUrls(await text('/')).filter((u) => u.endsWith('.js'))
  const portalFiles = brustUrls(await text('/portal')).filter((u) => u.endsWith('.js'))
  const onlyPortal = portalFiles.filter((u) => !rootFiles.some((r) => base(r) === base(u)))
  const onlyRoot = rootFiles.filter((u) => !portalFiles.some((p) => base(p) === base(u)))
  expect(onlyPortal.length).toBeGreaterThan(0)
  expect(onlyRoot.length).toBeGreaterThan(0)
  for (const f of onlyPortal) expect((await get(f.replace('/portal', ''))).status, f).toBe(404)
  for (const f of onlyRoot) expect((await get(`/portal${f}`)).status, f).toBe(404)
})

test('public files of each app live under its own URL', async () => {
  expect(await text('/public/p.txt')).toBe('root public file\n')
  expect(await text('/portal/public/p.txt')).toBe('portal public file\n')
  // the portal serves nothing at a root-level public path
  expect((await fetch(`${portalUrl}/public/p.txt`)).status).toBe(404)
})

test('pages: the portal routes are real URL paths under the base; its loader and params work', async () => {
  expect(await text('/portal/about')).toContain('portal about')
  expect(await text('/portal/orders/42')).toContain('order 42')
  expect(await text('/about')).toContain('root about')
  expect((await get('/portal/missing')).status).toBe(404)
})

test('/ping and the stats URL move under the base; a request outside it is a plain 404 from brust', async () => {
  expect(await text('/ping')).toBe('pong\n')
  expect(await text('/portal/ping')).toBe('pong\n')
  // straight at the portal app: its own tree answers, the rest of the origin is another app's
  expect((await fetch(`${portalUrl}/ping`)).status).toBe(404)
  expect((await fetch(`${portalUrl}/`)).status).toBe(404)
  expect((await fetch(`${portalUrl}/about`)).status).toBe(404)
  expect((await fetch(`${portalUrl}/portalx/ping`)).status).toBe(404)
  expect((await fetch(`${portalUrl}/_brust/action/who`)).status).toBe(404)
})

test('actions: each app answers under its own prefix; same-origin POST 200, cross-site POST 403', async () => {
  const body = JSON.stringify({ msg: 'hi' })
  const json = { 'content-type': 'application/json' }
  const same = { ...json, origin }
  expect(await (await get('/_brust/action/who')).json()).toEqual({ app: 'root' })
  expect(await (await get('/portal/_brust/action/who')).json()).toEqual({ app: 'portal' })
  const a = await get('/_brust/action/echo', { method: 'POST', headers: same, body })
  expect([a.status, await a.json()]).toEqual([200, { app: 'root', body: { msg: 'hi' } }])
  const b = await get('/portal/_brust/action/echo', { method: 'POST', headers: same, body })
  expect([b.status, await b.json()]).toEqual([200, { app: 'portal', body: { msg: 'hi' } }])
  for (const path of ['/_brust/action/echo', '/portal/_brust/action/echo']) {
    const x = await get(path, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body })
    expect(x.status, path).toBe(403)
  }
  // the root's actions are not under the portal's prefix, nor the portal's at the root's
  expect((await fetch(`${portalUrl}/_brust/action/who`)).status).toBe(404)
})

test('a route outside base_path is a named build error that lists it', () => {
  const b = build(bad)
  expect(b.code).not.toBe(0)
  expect(b.out).toContain('route-outside-base-path')
  expect(b.out).toContain('/other/{id}')
  expect(b.out).toContain('(/)')
  expect(existsSync(join(bad, 'dist/manifest.json'))).toBe(false)
})

// ---- brust dev: two apps behind the same path proxy, each with its own hot-reload channel under its own base ----

async function dev(app: string): Promise<{ url: string; proc: ReturnType<typeof Bun.spawn> }> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port as number
  s.stop(true)
  const proc = Bun.spawn([process.execPath, bin, 'dev', 'routes.tsx', '--port', String(port)], { cwd: app, env: shellEnv(), stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  let log = ''
  for (const st of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[])
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of st) log += dec.decode(c, { stream: true })
    })()
  for (let i = 0; i < 600 && !/\[brust\] ready/.test(log); i++) await Bun.sleep(100)
  if (!/\[brust\] ready/.test(log)) throw new Error(`brust dev not ready in ${app}:\n${log}`)
  return { url: `http://localhost:${port}`, proc }
}

test('brust dev: the dev channel lives under each app\'s base path, so both apps hot-reload behind one proxy', async () => {
  const [r, p] = await Promise.all([dev(root), dev(portal)])
  const edge = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const target = url.pathname === '/portal' || url.pathname.startsWith('/portal/') ? p.url : r.url
      if (req.headers.get('upgrade') === 'websocket') return new Response('use the app port', { status: 400 })
      void srv
      return fetch(`${target}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, redirect: 'manual' })
    },
  })
  try {
    const rootHtml = await (await fetch(`${edge.url.origin}/`)).text()
    const portalHtml = await (await fetch(`${edge.url.origin}/portal`)).text()
    expect(rootHtml).toContain('src="/_brust/dev/client.js?g=')
    expect(portalHtml).toContain('src="/portal/_brust/dev/client.js?g=')
    expect(portalHtml).toContain('src="/portal/_brust/dev/devtools.js"')
    expect(portalHtml).not.toContain('src="/_brust/dev/')
    // the dev scripts and the data they fetch resolve through the proxy, each at its own app's URL
    expect((await fetch(`${edge.url.origin}/portal/_brust/dev/client.js`)).status).toBe(200)
    expect((await fetch(`${edge.url.origin}/_brust/dev/client.js`)).status).toBe(200)
    expect((await (await fetch(`${edge.url.origin}/portal/_brust/dev/meta`)).json()) as object).toBeTruthy()
    // the socket: the portal's dev server speaks it at <base>/_brust/dev/ws, and says hello
    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://${p.url.slice('http://'.length)}/portal/_brust/dev/ws`)
      const t = setTimeout(() => reject(new Error('no hello')), 10_000)
      ws.onmessage = (e) => {
        clearTimeout(t)
        ws.close()
        resolve(JSON.parse(String(e.data)))
      }
      ws.onerror = () => reject(new Error('ws error'))
    })
    expect(hello.type).toBe('hello')
  } finally {
    edge.stop(true)
  }
}, 240_000)
