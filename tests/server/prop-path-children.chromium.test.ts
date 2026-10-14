// F148a in real Chromium: a static wrapper hands `{title}` and `{children}` to a React island. The island is
// server-rendered with them, hydrates without a console error or a mismatch, and opens. Request data that looks like
// the compiler's own nodes renders as nothing (R34.117, R34.124).
// Run alone: `bun test --timeout 120000 tests/server/prop-path-children.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/prop-path-children')
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

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 3, null, { timeout: 15_000 })
  return { page, errors }
}

test('server markup carries the wrapper\'s props and the caller\'s tree only after the island opens', async () => {
  const html = (await (await fetch(`${base}/`)).text()).replaceAll('<!-- -->', '')
  expect(html).toContain('Toggle one')
  expect(html).toContain('Toggle two')
  expect(html).toContain('Toggle root')
  expect(html).not.toContain('data-testid="inner-one"') // closed: it travels in x-props only
})

test('hydrates, opens, and renders the holes (text, attribute, condition, caller tree)', async () => {
  const { page, errors } = await open('/')
  await page.getByText('Toggle one').click()
  await page.waitForSelector('[data-testid="disc-one"][data-state="open"]')
  const note = page.locator('[data-testid="disc-one"] [data-testid="note"]')
  expect(await note.textContent()).toBe('T "q" \'a\' </script><b>x</b> & done')
  expect(await note.getAttribute('data-note')).toBe('T "q" \'a\' </script><b>x</b> & done')
  expect(await page.locator('[data-testid="disc-one"] [data-testid="shown"]').textContent()).toBe('shown')
  expect(await page.locator('[data-testid="inner-one"]').textContent()).toBe('inner one')
  // The second wrapper has no `shown` and no children.
  await page.getByText('Toggle two').click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="open"]')
  expect(await page.locator('[data-testid="disc-two"] [data-testid="shown"]').count()).toBe(0)
  expect(await page.locator('[data-testid="disc-two"] [data-testid="note"]').textContent()).toBe('plain')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('request data shaped like the compiler\'s nodes renders as nothing', async () => {
  const { page, errors } = await open('/hostile')
  await page.getByText('Toggle root').click()
  await page.waitForSelector('[data-testid="disc-root"][data-state="open"]')
  expect(await page.locator('[data-testid="root-note"]').textContent()).toBe('')
  expect(await page.locator('[data-testid="root-title"]').textContent()).toBe('ok')
  await page.getByText('Toggle two').click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="open"]')
  expect(await page.locator('[data-testid="disc-two"] [data-testid="note"]').textContent()).toBe('')
  expect(await page.locator('script', { hasText: '__pwned' }).count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
