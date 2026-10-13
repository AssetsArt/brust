// tests/server/css.chromium.test.ts — L19 css-pipeline in real Chromium on packages/brust/test/fixtures/css-app:
// getComputedStyle proves the [css] global, the layout CSS (@import, nesting), page CSS and CSS Modules apply, that the
// author's own <link> wins the cascade (brust's links come first), and that a native page, a hydrated React island and
// a client_only island get their module classes, with no page error and no hydration warning.
// Run alone: `bun test --timeout 120000 tests/server/css.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/css-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let browser: Browser | undefined

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
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
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

async function open(path: string, waitUntil: 'networkidle' | 'domcontentloaded' = 'networkidle'): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const ctx = await browser!.newContext()
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror ${e}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()} ${m.text()}`)
  })
  page.on('requestfailed', (r) => errors.push(`failed ${r.url()}`))
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
  })
  const res = await page.goto(base + path, { waitUntil })
  expect(res?.status()).toBe(200)
  return { page, errors, close: () => ctx.close() }
}

const style = (page: Page, sel: string, prop: string) =>
  page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s!)!).getPropertyValue(p!), [sel, prop])

test('global, layout (@import, nesting), page CSS and a module apply; the author link wins the cascade', async () => {
  const { page, errors, close } = await open('/')
  expect(await style(page, 'body', 'color')).toBe('rgb(1, 2, 3)') // [css] global
  expect(await style(page, 'h1', 'font-size')).toBe('31px') // layout.css
  expect(await style(page, 'h1', 'color')).toBe('rgb(200, 0, 0)') // /public/user.css, linked after brust's
  expect(await style(page, 'p', 'padding-left')).toBe('7px') // base.css through @import
  expect(await style(page, 'main h2', 'color')).toBe('rgb(4, 5, 6)') // nesting
  expect(await style(page, 'h2', 'text-transform')).toBe('uppercase') // home.css
  expect(await style(page, 'p', 'border-left-color')).toBe('rgb(0, 128, 0)') // Card.module.css (composes)
  expect(await style(page, 'p', 'font-weight')).toBe('700')
  // review N2: `composes: base from './Base.module.css'` puts both modules' classes on the element
  expect((await page.locator('p').getAttribute('class'))!.split(' ').map((c) => c.split('_')[0])).toEqual(['base', 'card', 'title'])
  expect(await style(page, 'p', 'margin-top')).toBe('9px')
  expect(await page.locator('link[data-brust-css]').count()).toBe(4)
  expect(errors).toEqual([])
  await close()
}, 60_000)

test('a native page keeps its module class and stays interactive', async () => {
  const { page, errors, close } = await open('/native')
  expect(await style(page, '#btn', 'background-color')).toBe('rgb(0, 0, 255)')
  await page.locator('#btn').click()
  await page.locator('#btn', { hasText: '1' }).waitFor()
  expect(errors).toEqual([])
  await close()
}, 60_000)

test('a hydrated React island and a client_only island get the module class, with no hydration warning', async () => {
  const { page, errors, close } = await open('/islands')
  await page.locator('brust-island[data-hydrated] #island').waitFor()
  expect(await style(page, '#island', 'outline-color')).toBe('rgb(255, 165, 0)')
  await page.locator('#island').click()
  await page.locator('#island', { hasText: '1' }).waitFor()
  await page.locator('#wide').waitFor()
  expect(await style(page, '#wide', 'outline-color')).toBe('rgb(255, 165, 0)')
  expect(await style(page, '#wide', 'outline-style')).toBe('solid')
  expect(errors).toEqual([])
  await close()
}, 60_000)

test('review N4: CSS reached only through a dynamic import() is applied on first paint', async () => {
  const { page, errors, close } = await open('/lazy', 'domcontentloaded')
  // before the lazy module is fetched, the page is already styled by its stylesheet
  expect(await page.locator('link[data-brust-css][href*="/lazy-"]').count()).toBe(1)
  expect(await style(page, '#lazy-target', 'color')).toBe('rgb(9, 8, 7)')
  await page.locator('#lazy-target[data-loaded="yes"]').waitFor()
  expect(errors).toEqual([])
  await close()
}, 60_000)
