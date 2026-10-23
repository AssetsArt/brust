// F388 in real Chromium: `left && <X/>` with a falsy NUMBER on the left renders the number as text (0, -0 as 0, NaN),
// as React does; false, null, undefined and '' render nothing; a string or object left keeps today's behaviour. The
// first paint of every page is compared with React's own render by what the browser shows (innerText, so the
// hidden branch brust keeps for the client does not count), hydrated AND with JavaScript off (the server HTML alone:
// a hidden branch must not paint), and the client flips 1 -> 0 -> 1 -> NaN with no duplicated text node.
// Run alone: `bun test --timeout 120000 tests/server/falsy-and.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderFlip, renderStatic, renderZero } from '../../packages/brust/test/fixtures/falsy-and/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/falsy-and')
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

/** What the browser shows for every `data-testid` element of a page (innerText skips `hidden` branches). */
async function shown(page: import('playwright').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll('[data-testid]').forEach((el, i) => {
      if (el.tagName !== 'BUTTON') out[`${i}:${el.getAttribute('data-testid')}`] = (el as HTMLElement).innerText
    })
    return out
  })
}

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  return { page, errors }
}

for (const [path, react] of [['/flip', renderFlip], ['/zero', renderZero], ['/static', renderStatic]] as const) {
  test(`${path}: served 200, no React island, and what it shows equals React's own render`, async () => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('brust-island')
    const { page, errors } = await open(path)
    const served = await shown(page)
    const ref = await browser.newPage()
    await ref.setContent(react())
    expect(served).toEqual(await shown(ref))
    await ref.close()
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
}

for (const [path, react] of [['/flip', renderFlip], ['/zero', renderZero], ['/static', renderStatic]] as const) {
  test(`${path}: with JavaScript off, the server HTML alone shows what React renders`, async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false })
    const page = await ctx.newPage()
    await page.goto(`${base}${path}`)
    const ref = await ctx.newPage()
    await ref.setContent(react())
    // Not `swap`: a hidden x-if copy that holds markup (its `{children}` arm) paints with JavaScript off, because the inline
    // `display:contents` beats `[hidden]`. That is older than F388 (every multi-node hidden branch) and is its own ledger
    // row; the hydrated comparison above covers `swap`.
    const drop = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.endsWith(':swap')))
    expect(drop(await shown(page))).toEqual(drop(await shown(ref)))
    await ctx.close()
  }, 60_000)
}

test('/zero: the falsy values themselves paint as React prints them', async () => {
  const { page } = await open('/zero')
  const t = async (id: string) => (await page.getByTestId(id).innerText())
  expect(await t('zero')).toBe('0')
  expect(await t('nan')).toBe('NaN')
  expect(await t('len')).toBe('0')
  expect(await t('str')).toBe('')
  expect(await t('negzero')).toBe('0')
  await page.close()
}, 60_000)

test('/flip: 1 -> 0 -> 1 -> NaN, items.length, in text, a string and an object left, no duplicated text', async () => {
  const { page, errors } = await open('/flip')
  const t = async (id: string) => (await page.getByTestId(id).innerText()).trim()
  const until = (id: string, v: string) =>
    page.waitForFunction(([i, w]) => (document.querySelector(`[data-testid="${i}"]`) as HTMLElement).innerText.trim() === w, [id, v])
  expect(await t('num')).toBe('yes')
  expect(await t('text')).toBe('count: on end')
  await page.getByTestId('n0').click()
  await until('num', '0')
  expect(await t('text')).toBe('count: 0 end')
  await page.getByTestId('n1').click()
  await until('num', 'yes')
  await page.getByTestId('n0').click()
  await until('num', '0')
  await page.getByTestId('n1').click()
  await until('num', 'yes')
  expect(await t('text')).toBe('count: on end')
  await page.getByTestId('nan').click()
  await until('num', 'NaN')
  expect(await t('text')).toBe('count: NaN end')
  await page.getByTestId('clear').click()
  await until('len', '0')
  await page.getByTestId('fill').click()
  await until('len', 'list')
  // A string left: '' renders nothing; an object left: null renders nothing (today's behaviour, pinned).
  expect(await t('str')).toBe('s')
  await page.getByTestId('s0').click()
  await until('str', '')
  expect(await t('obj')).toBe('o')
  await page.getByTestId('o0').click()
  await until('obj', '')
  // A `{children}` arm shows its markup after the flip, and again after a second round trip.
  expect(await t('swap')).toBe('tx')
  await page.getByTestId('swap-t').click()
  await until('swap', 'tkid')
  await page.getByTestId('swap-t').click()
  await until('swap', 'tx')
  await page.getByTestId('swap-t').click()
  await until('swap', 'tkid')
  // A boolean-seeded state written a number prints it (Mellow F1).
  expect(await t('bool-seeded')).toBe('')
  await page.getByTestId('bs-on').click()
  await until('bool-seeded', 'on')
  await page.getByTestId('bs-0').click()
  await until('bool-seeded', '0')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
