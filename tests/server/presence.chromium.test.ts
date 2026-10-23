// F288 phase A in real Chromium: `@radix-ui/react-presence` as published, with a function child, compiled native by the
// element-value fold (no React island). First paint equals React's own render (hydrated and with JavaScript off); the
// toggle drives Presence's own state machine: with no exit animation `present` follows `open` at once; with one
// (`fade`, 400ms) `present` stays true until `animationend`, as React's Presence does.
// Run alone: `bun test --timeout 120000 tests/server/presence.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPresence } from '../../packages/brust/test/fixtures/presence/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/presence')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
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

/** For every `data-testid` element: what it shows and its `data-*` state. */
async function shown(page: import('playwright').Page) {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll('[data-testid]').forEach((el, i) => {
      if (el.tagName === 'BUTTON') return
      const h = el as HTMLElement
      out[`${i}:${el.getAttribute('data-testid')}`] = `${h.innerText}|${h.dataset.present ?? ''}|${h.dataset.open ?? ''}`
    })
    return out
  })
}

test('served 200 with no React island; first paint equals React, hydrated and with JavaScript off', async () => {
  const res = await fetch(`${base}/presence`)
  expect(res.status).toBe(200)
  expect(await res.text()).not.toContain('brust-island')
  const ref = await browser.newPage()
  await ref.setContent(renderPresence())
  const want = await shown(ref)
  await ref.close()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/presence`, { waitUntil: 'networkidle' })
  expect(await shown(page)).toEqual(want)
  expect(errors).toEqual([])
  await page.close()
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  const nojs = await ctx.newPage()
  await nojs.goto(`${base}/presence`)
  expect(await shown(nojs)).toEqual(want)
  await ctx.close()
}, 60_000)

test('the toggle runs Presence: present follows open, and an exit animation holds it until animationend', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/presence`, { waitUntil: 'networkidle' })
  const state = (id: string) => page.evaluate((i) => {
    const p = document.querySelector(`[data-testid="${i}"] [data-testid="panel"]`) as HTMLElement
    return `${p.dataset.present}${p.dataset.open}`
  }, id)
  const until = (id: string, v: string) => page.waitForFunction(([i, w]) => {
    const p = document.querySelector(`[data-testid="${i}"] [data-testid="panel"]`) as HTMLElement
    return `${p.dataset.present}${p.dataset.open}` === w
  }, [id, v], { timeout: 5000 })
  expect(await state('plain')).toBe('nn')
  expect(await state('fade')).toBe('nn')
  for (let round = 0; round < 2; round++) {
    await page.getByTestId('toggle').click()
    await until('plain', 'yy')
    await until('fade', 'yy')
    await page.getByTestId('toggle').click()
    await until('plain', 'nn')
    // the closing animation runs: `present` is still true while `open` is already false
    expect(await state('fade')).toBe('yn')
    await until('fade', 'nn')
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('Mellow F1: a layout effect that writes runs before a passive effect that reads it on every re-run, as in React', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/le`, { waitUntil: 'networkidle' })
  const t = (id: string) => page.getByTestId(id).innerText()
  // mount: layout wrote v0 before the passive effect read it (React: the same)
  await page.waitForFunction(() => (document.querySelector('[data-testid="seen"]') as HTMLElement).innerText === 'v0')
  for (const k of [1, 2, 3]) {
    await page.getByTestId('inc').click()
    await page.waitForFunction((w) => (document.querySelector('[data-testid="n"]') as HTMLElement).innerText === w, String(k))
    await page.waitForFunction((w) => (document.querySelector('[data-testid="seen"]') as HTMLElement).innerText === w, `v${k}`)
    expect(await t('seen')).toBe(`v${k}`)
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

