// F420 + F421 in real Chromium: a controlled <select> paints `selected` on the option its value picks and a controlled
// <textarea> paints its value as text, as React's renderToString does, so the browser shows the right choice and text
// BEFORE hydration (JavaScript off = the server HTML alone). What each control shows (select.value / selectedOptions /
// textarea.value) is compared with React's own render of the same page in the same browser, and the client keeps its
// behaviour: choosing an option or typing updates the state echo.
// Run alone: `bun test --timeout 120000 tests/server/form-control-paint.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderSelect, renderTextarea } from '../../packages/brust/test/fixtures/form-control-paint/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/form-control-paint')
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

/** What the browser shows for each control: the chosen options' values, or the textarea's text. */
async function shown(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll('select[data-testid]').forEach((el) => {
      const s = el as HTMLSelectElement
      out[s.dataset.testid!] = [...s.selectedOptions].map((o) => o.value).join('|')
    })
    document.querySelectorAll('textarea[data-testid]').forEach((el) => {
      out[(el as HTMLElement).dataset.testid!] = (el as HTMLTextAreaElement).value
    })
    return out
  })
}

for (const [path, react] of [['/select', renderSelect], ['/textarea', renderTextarea]] as const) {
  test(`${path}: with JavaScript off, the server HTML alone shows what React renders`, async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false })
    const page = await ctx.newPage()
    await page.goto(`${base}${path}`)
    const ref = await ctx.newPage()
    await ref.setContent(react())
    const served = await shown(page)
    expect(served).toEqual(await shown(ref))
    // Pinned, so a both-empty comparison cannot pass: the picks and the text themselves.
    if (path === '/select') {
      expect(served).toMatchObject({ one: 'b', many: 'a|c', num: '2', text: 'two', default: 'c', plain: 'a' })
    } else {
      expect(served).toMatchObject({ ta: 'a<b & "c"', lead: '\nx', default: 'd & d', empty: '' })
    }
    // No `value` attribute is left on either control.
    expect(await page.locator('select[value], textarea[value]').count()).toBe(0)
    await ctx.close()
  }, 60_000)
}

test('/select: hydrated, the same picks stand and choosing an option updates the state', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${base}/select`, { waitUntil: 'networkidle' })
  const ref = await browser.newPage()
  await ref.setContent(renderSelect())
  expect(await shown(page)).toEqual(await shown(ref))
  await page.getByTestId('one').selectOption('c')
  await page.waitForFunction(([i, w]) => document.querySelector(`[data-testid="${i}"]`)!.textContent === w, ['one-echo', 'c'])
  expect((await shown(page)).one).toBe('c')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('/textarea: hydrated, the same text stands and typing updates the state', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${base}/textarea`, { waitUntil: 'networkidle' })
  const ref = await browser.newPage()
  await ref.setContent(renderTextarea())
  expect(await shown(page)).toEqual(await shown(ref))
  await page.getByTestId('ta').fill('typed')
  await page.waitForFunction(([i, w]) => document.querySelector(`[data-testid="${i}"]`)!.textContent === w, ['ta-echo', 'typed'])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
