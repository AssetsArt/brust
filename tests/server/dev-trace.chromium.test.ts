// tests/server/dev-trace.chromium.test.ts — `brust dev` trace + build metadata + DOM mapping (L14) in real Chromium.
// The trace rides `x-brust-dev` core -> proxy only; the page gets `#__brust_trace`; production builds carry none of it.
// Run alone: `bun test --timeout 180000 tests/server/dev-trace.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const host = join(import.meta.dir, '../fixtures/cf-min')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let app = ''
let base = ''
let proc: ReturnType<typeof Bun.spawn>
let browser: Browser
let log = ''

const doc = (body: string) => `<html lang="en"><head><meta charSet="utf-8" /><title>t</title></head><body>${body}</body></html>`

function files(): Record<string, string> {
  return {
    'routes.tsx': `import { defineRoutes } from '@brust/core/routes'
import Counter from './pages/Counter'
import Island from './pages/Island'
import Item from './pages/Item'

export const routes = defineRoutes([
  { path: '/counter', Component: Counter },
  { path: '/island', Component: Island },
  { path: '/item/{id}', Component: Item, loader: ({ params }) => ({ id: params.id }), cache: { ttl_seconds: 60 } },
])
`,
    'lib.ts': `export const shout = (s: string) => s.toUpperCase() + '!'\n`,
    'pages/Counter.tsx': `import { useState } from 'react'
export default function Counter() {
  const [n, setN] = useState(0)
  return ${doc('<button type="button" data-testid="inc" onClick={() => setN(n + 1)}>n {n}</button>')}
}
`,
    'pages/Island.tsx': `import { useReducer, useTransition } from 'react'
export default function Island() {
  useTransition()
  const [n, inc] = useReducer((x: number) => x + 1, 0)
  return ${doc('<button type="button" data-testid="rb" onClick={inc}>r {n}</button>')}
}
`,
    'pages/Item.tsx': `import { shout } from '../lib'
export default function Item({ id }: { id: string }) {
  return ${doc('<h1 data-testid="t">{shout(id)}</h1>')}
}
`,
    'brust.toml': '[actions]\nentry = "actions.ts"\n',
    'actions.ts': `import { brust } from '@brust/core/elysia'\nimport { Elysia } from 'elysia'\nexport default new Elysia({ adapter: brust() }).post('/echo', () => ({ ok: true }))\n`,
  }
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
const traceOf = (page: Page) => page.evaluate(() => JSON.parse(document.getElementById('__brust_trace')?.textContent ?? 'null'))

beforeAll(async () => {
  app = mkdtempSync(join(host, '.devtest-trace-'))
  mkdirSync(join(app, 'pages'))
  for (const [f, s] of Object.entries(files())) writeFileSync(join(app, f), s)
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = s.port as number
  s.stop(true)
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
  if (proc && proc.exitCode === null) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, sleep(8000).then(() => undefined)])) === undefined) proc.kill('SIGKILL')
  }
  rmSync(app, { recursive: true, force: true })
})

test('a page carries its trace in #__brust_trace: route, params, cache, loader and render ms, jobs, components; never as a header', async () => {
  const page = await browser.newPage()
  const res = await page.goto(`${base}/item/abc`, { waitUntil: 'domcontentloaded' })
  expect(await page.locator('[data-testid="t"]').textContent()).toBe('ABC!')
  expect(await res?.headerValue('x-brust-dev')).toBeNull()
  const t = await traceOf(page)
  expect(t.route.pattern).toBe('/item/{id}')
  expect(t.route.params).toEqual({ id: 'abc' })
  expect(t.route.chain.length).toBeGreaterThan(0)
  expect(t.cache).toBe('MISS')
  expect(t.status).toBe(200)
  expect(typeof t.loader_ms).toBe('number')
  expect(typeof t.render_ms).toBe('number')
  expect(t.bun_calls).toBeGreaterThanOrEqual(1)
  expect(t.jobs.length).toBeGreaterThan(0)
  expect(t.jobs[0]).toMatchObject({ kind: 'precompute', hit: false })
  expect(t.rendered).toContain(t.route.chain.at(-1))
  // the second load is a HIT with its own fresh trace: nothing of the MISS is replayed
  await page.goto(`${base}/item/abc`, { waitUntil: 'domcontentloaded' })
  const h = await traceOf(page)
  expect(h.cache).toBe('HIT')
  expect(h.loader_ms).toBeNull()
  expect(h.render_ms).toBeNull()
  expect(h.jobs).toEqual([])
  expect(h.bun_calls).toBe(0)
  await page.close()
}, 60_000)

test('a client-sent token header does nothing: only the proxy has the token', async () => {
  const r = await fetch(`${base}/item/zzz`, { headers: { 'x-brust-dev-token': 'guess', accept: 'text/html' } })
  expect(r.headers.get('x-brust-dev')).toBeNull()
  expect(await r.text()).toContain('id="__brust_trace"') // the proxy added its own, from its own token
})

test('dev DOM: inner chain levels are wrapped in <!--brust-l:id:hash--> markers and the root is on the nav tag, native instances are on __brustDev, hydration and clicks still work', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/counter`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="inc"]').waitFor()
  const t = await traceOf(page)
  const markers = await page.evaluate(() => {
    const out: string[] = []
    const w = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const v = n.nodeValue ?? ''
      if (v.startsWith('brust-l:')) out.push(v.slice(8, v.lastIndexOf(':')))
    }
    return out
  })
  // The root level is carried on the nav tag (data-brust-root = id:hash), every inner level by a comment pair.
  const root = await page.evaluate(() => document.querySelector('script[data-brust-nav]')?.getAttribute('data-brust-root') ?? '')
  expect([root.slice(0, root.lastIndexOf(':')), ...markers]).toEqual(t.route.chain.filter((id: string) => id === root.slice(0, root.lastIndexOf(':')) || markers.includes(id)))
  expect(root).not.toBe('') // /counter is a one-level chain: the root is its only level, so no comment pair
  await eventually(async () => (await page.evaluate(() => (window as unknown as { __brustDev?: { instances: Set<unknown> } }).__brustDev?.instances.size ?? 0)) > 0, 'a live instance on __brustDev')
  const names = await page.evaluate(() => [...((window as unknown as { __brustDev: { instances: Set<{ name: string; host: Element }> } }).__brustDev.instances)].map((i) => `${i.name}:${i.host.getAttribute('x-data')}`))
  expect(names.length).toBeGreaterThan(0)
  expect(names[0]?.split(':')[0]).toBe(names[0]?.split(':')[1])
  await page.locator('[data-testid="inc"]').click()
  await eventually(async () => (await page.locator('[data-testid="inc"]').textContent())?.trim() === 'n 1', 'the click to update the native button')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a react island page: no marker inside <brust-island>, it hydrates with no error and is interactive', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/island`, { waitUntil: 'domcontentloaded' })
  await page.locator('brust-island[data-hydrated="1"]').waitFor({ state: 'attached', timeout: 15_000 })
  const inside = await page.evaluate(() => {
    let n = 0
    for (const isl of document.querySelectorAll('brust-island')) {
      const w = document.createTreeWalker(isl, NodeFilter.SHOW_COMMENT)
      for (let c = w.nextNode(); c; c = w.nextNode()) if ((c.nodeValue ?? '').startsWith('brust-l:')) n++
    }
    return n
  })
  expect(inside).toBe(0)
  await page.locator('[data-testid="rb"]').click()
  await eventually(async () => (await page.locator('[data-testid="rb"]').textContent())?.trim() === 'r 1', 'the island click')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('/_brust/dev/traces keeps the last 50 traces, actions included', async () => {
  for (let i = 0; i < 3; i++) await fetch(`${base}/item/n${i}`, { headers: { accept: 'text/html' } })
  const post = await fetch(`${base}/_brust/action/echo`, { method: 'POST' })
  expect(post.status).toBe(200)
  const j = (await (await fetch(`${base}/_brust/dev/traces`)).json()) as { traces: { kind: string; path: string; method: string; trace: unknown }[] }
  expect(j.traces.some((t) => t.kind === 'page' && t.path === '/item/n2' && t.trace !== null)).toBe(true)
  expect(j.traces.some((t) => t.kind === 'action' && t.method === 'POST' && t.path === '/_brust/action/echo')).toBe(true)
  for (let i = 0; i < 60; i++) await fetch(`${base}/_brust/action/echo`, { method: 'POST' })
  const j2 = (await (await fetch(`${base}/_brust/dev/traces`)).json()) as { traces: unknown[] }
  expect(j2.traces.length).toBe(50)
})

test('dev.json: component -> file, tier, react reason, diagnostics; its tiers equal the manifest; a production build writes none and no dev code', async () => {
  const dev = join(app, '.dev-out')
  const prod = join(app, '.prod-out')
  for (const [out, flag] of [[dev, ['--dev']], [prod, []]] as const) {
    const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out, ...flag], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    expect(b.exitCode, b.stderr.toString()).toBe(0)
  }
  const meta = JSON.parse(readFileSync(join(dev, 'dev.json'), 'utf8')) as { components: Record<string, { file: string; tier: string; reason?: string; diagnostics: { rule: string; line: number; col: number; remediation: string }[] }> }
  const manifest = JSON.parse(readFileSync(join(dev, 'manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  expect(Object.keys(meta.components).sort()).toEqual(Object.keys(manifest.components).sort())
  for (const [id, c] of Object.entries(meta.components)) {
    expect([id, c.tier]).toEqual([id, manifest.components[id]?.tier as string])
    expect([id, c.file.endsWith('.tsx')]).toEqual([id, true])
    expect([id, c.tier === 'react' ? typeof c.reason === 'string' && c.reason.length > 0 : c.reason === undefined]).toEqual([id, true])
  }
  const island = Object.values(meta.components).find((c) => c.file.endsWith('Island.tsx'))
  expect(island?.tier).toBe('react')
  expect(island?.diagnostics.some((d) => d.rule.length > 0 && typeof d.line === 'number' && typeof d.remediation === 'string')).toBe(true)
  // production: no dev.json, and the client runtime has no dev global
  expect(existsSync(join(prod, 'dev.json'))).toBe(false)
  const runtime = readdirSync(join(prod, 'client')).filter((f) => f.startsWith('runtime-'))
  expect(runtime.length).toBe(1)
  expect(readFileSync(join(prod, 'client', runtime[0] as string), 'utf8')).not.toContain('__brustDev')
  const devRuntime = readdirSync(join(dev, 'client')).filter((f) => f.startsWith('runtime-'))
  expect(readFileSync(join(dev, 'client', devRuntime[0] as string), 'utf8')).toContain('__brustDev')
  rmSync(dev, { recursive: true, force: true })
  rmSync(prod, { recursive: true, force: true })
}, 120_000)

test('a document with a doctype stays in standards mode with the level markers (compatMode CSS1Compat); a layout without one gets one (F392); a non-document control stays BackCompat', async () => {
  const out = join(app, '.doctype-out')
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out, '--dev'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.exitCode, b.stderr.toString()).toBe(0)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { routes: { pattern: string; chain: string[] }[]; components: Record<string, { template: string }> }
  const rootId = manifest.routes.find((r) => r.pattern === '/counter')?.chain[0] as string
  const tpl = join(out, manifest.components[rootId]?.template as string)
  const original = readFileSync(tpl, 'utf8')
  async function serve(html: string) {
    writeFileSync(tpl, html)
    const p = Bun.spawn([bin, 'start', '--dist-dir', out, '--entry', join(app, 'routes.tsx'), '--port', '0', '--workers', '1'], {
      cwd: app,
      env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_DIST_DIR: '', BRUST_APP_ENTRY: '', NODE_ENV: 'development', BRUST_DEV_TOKEN: 'doctype-test-token' },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader()
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
    return { url: `http://${/listening on (\S+)/.exec(o)?.[1]}`, stop: async () => { p.kill('SIGINT'); await Promise.race([p.exited, sleep(5000)]); p.kill('SIGKILL') } }
  }
  const mode = async (html: string) => {
    const s = await serve(html)
    try {
      const page = await browser.newPage()
      await page.goto(`${s.url}/counter`, { waitUntil: 'domcontentloaded' })
      const r = await page.evaluate(() => {
        const w = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT)
        // F453: no comment ahead of the doctype either; the root level's mark is the nav tag's data-brust-root.
        let markers = document.querySelector('script[data-brust-nav][data-brust-root]') ? 1 : 0
        for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.nodeValue ?? '').startsWith('brust-l:')) markers++
        return { compat: document.compatMode, markers, doctype: document.doctype?.name ?? null, firstNode: document.childNodes[0]?.nodeType ?? 0 }
      })
      await page.close()
      return r
    } finally {
      await s.stop()
    }
  }
  try {
    const withDoctype = await mode(`<!doctype html>${original}`)
    expect(withDoctype).toEqual({ compat: 'CSS1Compat', markers: withDoctype.markers, doctype: 'html', firstNode: 10 }) // the doctype is the document's FIRST node (10), no marker before it
    expect(withDoctype.markers).toBeGreaterThan(0) // the root mark is there (on the nav tag)
    // F392: a root layout with no doctype of its own gets one, in front of everything
    const bare = await mode(original)
    expect(bare).toEqual({ compat: 'CSS1Compat', markers: bare.markers, doctype: 'html', firstNode: 10 })
    // the control: a document that is not a full document (an element ahead of `<html>`) gets no doctype and is quirks,
    // so the assertions above are not vacuous
    const without = await mode(`<meta charset="utf-8">${original}`)
    expect(without.compat).toBe('BackCompat')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 120_000)
