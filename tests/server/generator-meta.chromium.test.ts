// F468 in real Chromium, against packages/brust/test/fixtures/generator-meta: every full document brust renders carries
// exactly one `<meta name="generator" content="brust/<version>">`, the same string as `X-Powered-By`. A native page, a
// React-tier page and the * route's 404 are served (`brust start`) with one meta that equals the header; a page that
// wrote its own generator keeps the app's and gets none from brust; `brust build --target static` files carry it (a static
// host has no header); an SPA navigation keeps the one meta node (never duplicated, never replaced, so never flashed).
// Run alone: `bun test --timeout 180000 tests/server/generator-meta.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/generator-meta')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  for (const args of [['build', 'routes.tsx'], ['build', 'routes.tsx', '--target', 'static']]) {
    const b = Bun.spawnSync([bin, ...args], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust ${args.join(' ')} failed:\n${b.stderr.toString()}`)
  }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** The generator metas of a document's HTML text, as their `content` values. */
const metas = (html: string) => [...html.matchAll(/<meta\b[^>]*\bname=["']generator["'][^>]*>/gi)].map((m) => /content="([^"]*)"/.exec(m[0])?.[1])

test('the manifest has the tiers the test relies on: a native page and a React-tier page', () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'))
  const tierOf = (path: string) => {
    const r = m.routes.find((r: { pattern: string }) => r.pattern === path)
    return m.components[r.chain.at(-1)].tier
  }
  expect(tierOf('/')).toBe('native')
  expect(tierOf('/react')).toBe('react')
})

test('a native page, a React page and the 404 each carry one meta equal to X-Powered-By', async () => {
  for (const [path, status] of [['/', 200], ['/react', 200], ['/missing', 404]] as const) {
    const res = await fetch(base + path)
    expect(res.status).toBe(status)
    const header = res.headers.get('x-powered-by')
    expect(header).toMatch(/^brust\/\d+\.\d+\.\d+/)
    const html = await res.text()
    expect(metas(html), path).toEqual([header])
    // it is in the head, not the body
    expect(html.indexOf('name="generator"'), path).toBeLessThan(html.indexOf('</head>'))
  }
})

test('a second request (a cache HIT or a fresh render) is the same single meta', async () => {
  for (let i = 0; i < 2; i++) expect(metas(await (await fetch(`${base}/react`)).text())).toHaveLength(1)
})

test("a page that wrote its own generator keeps the app's and gets none from brust", async () => {
  const res = await fetch(`${base}/own`)
  expect(res.headers.get('x-powered-by')).toMatch(/^brust\//)
  expect(metas(await res.text())).toEqual(['my-own-tool/1'])
})

test('a non-document response (the runtime asset, /ping) has no meta', async () => {
  const ping = await fetch(`${base}/ping`)
  expect(ping.headers.get('x-powered-by')).toMatch(/^brust\//)
  expect(await ping.text()).not.toContain('generator')
})

test('--target static pages carry the meta (a static host has no header)', () => {
  const header = /brust\/\S+/.exec(readFileSync(join(app, 'dist/static/_headers'), 'utf8'))?.[0]
  expect(header).toMatch(/^brust\/\d/)
  for (const f of ['index.html', 'react.html', '404.html']) expect(metas(readFileSync(join(app, 'dist/static', f), 'utf8')), f).toEqual([header])
  expect(metas(readFileSync(join(app, 'dist/static/own.html'), 'utf8'))).toEqual(['my-own-tool/1'])
})

test('an SPA navigation keeps the one meta node: not duplicated, not replaced', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(base + '/')
  await page.waitForSelector('script[data-brust-nav]', { state: 'attached' })
  await page.evaluate(() => {
    ;(window as unknown as { __mark: number }).__mark = 1
    ;(document.querySelector('meta[name=generator]') as unknown as { __same: number }).__same = 1
  })
  const count = () => page.evaluate(() => document.head.querySelectorAll('meta[name=generator]').length)
  const same = () => page.evaluate(() => (document.querySelector('meta[name=generator]') as unknown as { __same?: number } | null)?.__same)
  // a MutationObserver counts every generator meta ever inserted into the head while we navigate
  await page.evaluate(() => {
    ;(window as unknown as { __added: number }).__added = 0
    new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.addedNodes) if ((n as Element).matches?.('meta[name=generator]')) (window as unknown as { __added: number }).__added++
    }).observe(document.head, { childList: true })
  })
  for (const [href, page_] of [['/react', 'react'], ['/', 'home'], ['/missing', 'missing']] as const) {
    await page.click(`nav a[href="${href}"]`)
    await page.waitForSelector(`[data-page=${page_}]`)
    expect(await count(), href).toBe(1)
    expect(await same(), href).toBe(1)
    expect(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark), `${href} was a full load`).toBe(1)
  }
  expect(await page.evaluate(() => (window as unknown as { __added: number }).__added)).toBe(0)
  // /own has its own generator: the SPA head reconcile ends with that one only (same as a full load of /own)
  await page.click('nav a[href="/own"]')
  await page.waitForSelector('[data-page=own]')
  expect(await page.evaluate(() => [...document.head.querySelectorAll('meta[name=generator]')].map((m) => m.getAttribute('content')))).toEqual(['my-own-tool/1'])
  await ctx.close()
})
