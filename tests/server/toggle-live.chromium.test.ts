// 2b-handlers (R34.18 extended) in real Chromium: the shadcn `Toggle` built from the PUBLISHED Radix source. The page has
// no React island: the toggle's live `aria-pressed` / `data-state` and its click handler are bound by the toggle itself on
// the button the static `Primitive.button` child prints (the parent binds them; the child has no link).
// First paint is React's (`aria-pressed="false"`, not omitted); a click flips both attributes and a second click flips
// them back, still printed as "false"; a click whose default was already prevented does nothing, as in React
// (`composeEventHandlers` checks `event.defaultPrevented`).
// Run alone: `bun test --timeout 120000 tests/server/toggle-live.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/toggle-live-routes.tsx'
const OUT = '.rows/dist-toggle-live'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport TogglePage from "../repro/ctx-page-toggle"\nexport const routes = defineRoutes([\n  { path: "/toggle", Component: TogglePage },\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', OUT], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', OUT, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
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
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})

async function open() {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/toggle`, { waitUntil: 'load' })
  // The native chunk binds on idle; wait until it has (the button carries a live binding once mounted).
  await page.waitForFunction(() => !!document.querySelector('[x-data]') && document.querySelectorAll('button[aria-pressed]').length === 2)
  return { page, errors }
}
const state = (page: import('playwright').Page, label: string) =>
  page.getByLabel(label).evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), state: b.getAttribute('data-state') }))

test('first paint is the unpressed state React prints, with no React island on the page', async () => {
  const { page, errors } = await open()
  expect(await state(page, 'Toggle italic')).toEqual({ pressed: 'false', state: 'off' })
  expect(await state(page, 'Toggle bold')).toEqual({ pressed: 'false', state: 'off' })
  expect(await page.locator('brust-island').count()).toBe(0)
  expect(errors).toEqual([])
  await page.close()
})

test('a click flips aria-pressed and data-state of that toggle only, and a second click flips them back (still "false", not omitted)', async () => {
  const { page, errors } = await open()
  await page.getByLabel('Toggle italic').click()
  expect(await state(page, 'Toggle italic')).toEqual({ pressed: 'true', state: 'on' })
  expect(await state(page, 'Toggle bold')).toEqual({ pressed: 'false', state: 'off' })
  await page.getByLabel('Toggle italic').click()
  expect(await state(page, 'Toggle italic')).toEqual({ pressed: 'false', state: 'off' })
  await page.getByLabel('Toggle bold').click()
  expect(await state(page, 'Toggle bold')).toEqual({ pressed: 'true', state: 'on' })
  expect(errors).toEqual([])
  await page.close()
})

test('a click whose default was prevented before it reached the toggle does nothing (composeEventHandlers checks defaultPrevented)', async () => {
  const { page, errors } = await open()
  await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), true))
  await page.getByLabel('Toggle italic').click()
  expect(await state(page, 'Toggle italic')).toEqual({ pressed: 'false', state: 'off' })
  expect(errors).toEqual([])
  await page.close()
})
