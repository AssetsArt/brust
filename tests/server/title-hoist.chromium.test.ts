// F399 (Assets Art B-5) in real Chromium, against React rendering the same document. A <title>, <meta> and <link> a page
// renders in its body are hoisted into <head> (React 19), after the head's own children and in render order, and the
// body copy is gone; an SVG <title> stays. Served (`brust start`) and static (`brust build --target static`) files carry
// the same head as React's own render, and `document.title` is React's. v2 navigates with full page loads (no SPA
// payload), so each route's title is checked by loading it.
// Run alone: `bun test --timeout 120000 tests/server/title-hoist.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/title-hoist/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/title-hoist')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const routes: Record<string, string> = { home: '/', about: '/about', plain: '/plain' }
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  for (const args of [['build', 'routes.tsx'], ['build', 'routes.tsx', '--target', 'static']]) {
    const b = Bun.spawnSync([bin, ...args], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust ${args.join(' ')} failed:\n${b.stderr.toString()}`)
  }
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
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** What a document says about itself: the head's children in order, titles/metas/links left in the body, `document.title`. */
const observe = (html: string) =>
  browser.newPage().then(async (p) => {
    await p.setContent(html, { waitUntil: 'domcontentloaded' })
    const seen = await p.evaluate(() => {
      const sig = (e: Element) => `${e.localName}${[...e.attributes].map((a) => `[${a.name.toLowerCase()}=${a.value}]`).join('')}${e.localName === 'title' ? `:${e.textContent}` : ''}`
      return {
        title: document.title,
        head: [...document.head.children].map(sig),
        bodyHoistables: [...document.body.querySelectorAll('title, meta, link')].filter((e) => !e.closest('svg')).map(sig),
        svgTitle: document.body.querySelector('svg title')?.textContent ?? null,
      }
    })
    await p.close()
    return seen
  })

for (const [name, path] of Object.entries(routes)) {
  test(`${name}: served and static head, body and document.title equal React's own render`, async () => {
    const react = await observe(`<!doctype html>${renderPage(name)}`)
    const served = await observe(await (await fetch(base + path)).text())
    const file = path === '/' ? 'index.html' : `${path.slice(1)}.html`
    const statik = await observe(readFileSync(join(app, 'dist/static', file), 'utf8'))
    expect(react.bodyHoistables).toEqual([])
    expect(served).toEqual(react)
    expect(statik).toEqual(react)
  }, 60_000)
}

test('the pages differ: each route has its own title after the layout title, a page without one keeps the layout title', async () => {
  const titles = await Promise.all(Object.values(routes).map(async (p) => (await observe(await (await fetch(base + p)).text())).head.filter((h) => h.startsWith('title')).map((t) => t.slice(6))))
  expect(titles).toEqual([['Site', 'Home page'], ['Site', 'About us'], ['Site']])
})
