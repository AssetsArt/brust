// shadcn S1 (R34.21–R34.22) in real Chromium: a static page hands constant JSX children to two React islands. They are
// server-rendered with their children, hydrate without a console error or a hydration mismatch, a click on a
// nested Trigger (context) opens the nested Body, and `asChild` hands the click to the page's own <button>.
// Run alone: `bun test --timeout 120000 tests/server/island-children.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/island-children')
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
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length === 2, null, { timeout: 15_000 })
  return { page, errors }
}

test('the islands are server-rendered with their children', async () => {
  const html = (await (await fetch(`${base}/`)).text()).replaceAll('<!-- -->', '')
  expect(html).toContain('Toggle one')
  expect(html).toContain('Toggle two')
  expect(html).toContain('class="as-child"')
  expect(html).toContain('data-state="closed"')
  // Bodies are closed: their children travel in x-props only.
  expect(html).not.toContain('data-testid="body"')
})

test('hydrates, then the nested Trigger (context) opens the nested Body', async () => {
  const { page, errors } = await open('/')
  await page.getByText('Toggle one').click()
  await page.waitForSelector('[data-testid="disc-one"][data-state="open"]')
  const body = page.locator('[data-testid="disc-one"] [data-testid="body"]')
  expect((await body.textContent())?.replaceAll(/\s+/g, ' ').trim()).toBe('Secret one tagged')
  expect(await page.locator('[data-testid="disc-one"] em.tag').textContent()).toBe('tagged')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('asChild: the click reaches the page\'s own button, with its class and test id', async () => {
  const { page, errors } = await open('/')
  const trigger = page.locator('[data-testid="trigger-two"]')
  expect(await trigger.getAttribute('class')).toBe('as-child')
  await trigger.click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="open"]')
  expect(await page.locator('[data-testid="disc-two"] [data-testid="body"]').textContent()).toBe('Secret two "q" \'a\' </script><b>x</b> & done')
  await trigger.click()
  await page.waitForSelector('[data-testid="disc-two"][data-state="closed"]')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
