// F384 in real Chromium: `{cond && children}` / `{cond ? children : null}` in a component that receives children,
// plainly and inside a specialised Provider clone (Radix CollapsibleContentImpl's `{isOpen && children}`). Such pages
// were React ('reads `children` as a value'); now they are native, the first paint equals React's own render, and the
// children follow the condition both ways.
// Run alone: `bun test --timeout 120000 tests/server/cond-children.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderCond, renderGate } from '../../packages/brust/test/fixtures/cond-children/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/cond-children')
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

for (const [path, react] of [['/cond', renderCond], ['/gate', renderGate]] as const) {
test(`${path}: served 200, no React island, and what it shows equals React's own render`, async () => {
  const res = await fetch(`${base}${path}`)
  expect(res.status).toBe(200)
  expect(await res.text()).not.toContain('brust-island')
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  const ref = await browser.newPage()
  await ref.setContent(react())
  expect(await shown(page)).toEqual(await shown(ref))
  await ref.close()
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
}

test('/cond: the children follow the condition, open and closed, twice', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/cond`, { waitUntil: 'networkidle' })
  const t = async (id: string) => (await page.getByTestId(id).innerText()).trim()
  const until = (id: string, v: string) =>
    page.waitForFunction(([i, w]) => (document.querySelector(`[data-testid="${i}"]`) as HTMLElement).innerText.trim() === w, [id, v])
  expect(await t('plain')).toBe('')
  expect(await t('panel')).toBe('')
  expect(await t('ternary')).toBe('')
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('plain-toggle').click()
    await until('plain', 'plain child')
    await page.getByTestId('prov-toggle').click()
    await until('panel', 'panel child')
    await until('ternary', 'ternary child')
    expect(await page.getByTestId('panel').getAttribute('data-open')).toBe('y')
    await page.getByTestId('plain-toggle').click()
    await until('plain', '')
    await page.getByTestId('prov-toggle').click()
    await until('panel', '')
    await until('ternary', '')
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('/gate: the page\'s state in the gated slot follows while open, and is current again after a reopen', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/gate`, { waitUntil: 'networkidle' })
  const gate = () => page.getByTestId('gate').innerText().then((s) => s.replace(/\s+/g, ''))
  expect(await gate()).toBe('tb')
  await page.getByTestId('flip').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="gate"]') as HTMLElement).innerText.includes('a'))
  await page.getByTestId('gate-toggle').click()
  await page.waitForFunction(() => !(document.querySelector('[data-testid="gate"]') as HTMLElement).innerText.includes('a'))
  expect(await gate()).toBe('t')
  await page.getByTestId('flip').click()
  await page.getByTestId('gate-toggle').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="gate"]') as HTMLElement).innerText.replace(/\s+/g, '') === 'tb')
  await page.getByTestId('flip').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="gate"]') as HTMLElement).innerText.replace(/\s+/g, '') === 'ta')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
