// tests/server/tailwind.chromium.test.ts — L21 Tailwind CSS v4 in real Chromium: utility classes and a module's @apply
// on packages/brust/test/fixtures/tw-app (built, `brust start`), and `brust dev` swapping the built stylesheet after a
// CSS-only edit with no reload (L19/L21 dev swap: the `window.__m` marker survives, the colour changes).
// Run alone: `bun test --timeout 180000 tests/server/tailwind.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const fixture = join(import.meta.dir, '../../packages/brust/test/fixtures/tw-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
// A sub-directory of a workspace member, so `@brust/core`, `react` and the pinned Tailwind packages resolve.
const devHost = join(import.meta.dir, '../fixtures/cf-min')
let browser: Browser
const procs: ReturnType<typeof Bun.spawn>[] = []
let devApp = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function eventually<T>(fn: () => Promise<T | undefined | false>, what: string, timeout = 60_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}
async function stop(p: ReturnType<typeof Bun.spawn>) {
  p.kill('SIGINT')
  if ((await Promise.race([p.exited, sleep(8000).then(() => undefined)])) === undefined) {
    p.kill('SIGKILL')
    await p.exited
  }
}
const style = (page: Page, sel: string, prop: string) =>
  page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s!)!).getPropertyValue(p!), [sel, prop])

beforeAll(async () => {
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  for (const p of procs) await stop(p)
  rmSync(join(fixture, 'dist'), { recursive: true, force: true })
  if (devApp) rmSync(devApp, { recursive: true, force: true })
})

test('built: a utility, a @theme token, a responsive variant and a module @apply all apply', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' })
  expect([b.exitCode, b.stderr.toString()]).toEqual([0, ''])
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: fixture, env, stdout: 'pipe', stderr: 'inherit' })
  procs.push(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  expect(await style(page, '#title', 'color')).toBe('rgb(12, 34, 56)') // text-brand from @theme
  expect(await style(page, '#title', 'font-weight')).toBe('700') // font-bold
  expect(await style(page, '#title', 'font-size')).toBe('36px') // md:text-4xl at 1024px
  expect(await style(page, '#card', 'padding-top')).toBe('16px') // .card { @apply p-4 }
  expect(await style(page, '#card', 'color')).toBe('rgb(12, 34, 56)')
  await page.setViewportSize({ width: 400, height: 700 })
  expect(await style(page, '#title', 'font-size')).not.toBe('36px') // below md
  expect(errors).toEqual([])
  await ctx.close()
}, 120_000)

test('brust dev: a CSS-only edit swaps the built stylesheet with no reload; the new @theme colour applies', async () => {
  devApp = mkdtempSync(join(devHost, '.twdev-'))
  mkdirSync(join(devApp, 'pages'))
  const appCss = (color: string) => `@import "tailwindcss";\n@theme {\n  --color-brand: ${color};\n}\n`
  writeFileSync(join(devApp, 'app.css'), appCss('rgb(255, 0, 0)'))
  writeFileSync(
    join(devApp, 'pages/Home.tsx'),
    `import '../app.css'\nexport default function Home() {\n  return (\n    <html lang="en"><head><meta charSet="utf-8" /><title>tw</title></head><body><h1 data-testid="t" className="text-brand">hi</h1></body></html>\n  )\n}\n`,
  )
  writeFileSync(join(devApp, 'routes.tsx'), `import { defineRoutes } from '@brust/core/routes'\nimport Home from './pages/Home'\nexport const routes = defineRoutes([{ path: '/', Component: Home }])\n`)
  const port = (() => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const p = s.port as number
    s.stop(true)
    return p
  })()
  let log = ''
  const proc = Bun.spawn([bin, 'dev', 'routes.tsx', '--port', String(port)], {
    cwd: devApp,
    env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'development', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  procs.push(proc)
  for (const s of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[])
    void (async () => {
      const dec = new TextDecoder()
      for await (const c of s) log += dec.decode(c, { stream: true })
    })()
  await eventually(async () => /\[brust\] ready \S+ gen 1/.test(log), `dev gen 1\n${log}`, 120_000)
  const page = await browser.newPage()
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="t"]').waitFor()
  const color = () => page.locator('[data-testid="t"]').evaluate((e) => getComputedStyle(e).color)
  expect(await color()).toBe('rgb(255, 0, 0)')
  const hrefBefore = await page.locator('link[data-brust-css]').getAttribute('href')
  await page.evaluate(() => {
    ;(window as unknown as { __m: number }).__m = 1
  })
  await sleep(300) // the dev client has connected
  writeFileSync(join(devApp, 'app.css'), appCss('rgb(0, 0, 255)'))
  await eventually(async () => (await color()) === 'rgb(0, 0, 255)', `the new colour\n${log}`)
  expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(1) // no reload
  const hrefAfter = await page.locator('link[data-brust-css]').getAttribute('href')
  expect(hrefAfter).not.toBe(hrefBefore)
  expect(hrefAfter).toMatch(/^\/_brust\/client\/app-[0-9a-f]{10}\.css$/)
  expect(log).toContain('css rebuilt (1 stylesheet swapped, no reload)')
  await page.close()
}, 240_000)
