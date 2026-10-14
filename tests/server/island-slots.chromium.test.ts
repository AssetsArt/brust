// shadcn S1 (R34.50–R34.52) in real Chromium: a static page hands folded lists, a constant condition and element props
// to two React islands. They are server-rendered with the element prop, hydrate without a console error or a hydration
// mismatch, and a click shows the unrolled children (hostile text included, as text).
// Run alone: `bun test --timeout 120000 tests/server/island-slots.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/island-slots')
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

test('the islands are server-rendered with their element prop; the children wait for a click', async () => {
  const html = (await (await fetch(`${base}/`)).text()).replaceAll('<!-- -->', '')
  expect(html).toContain('<em class="badge loud">hint</em>')
  expect(html).toContain('<b>a</b><em class="badge plain">frag</em>')
  expect(html).toContain('data-state="closed"')
  // The closed bodies are not in the markup; their trees travel in x-props.
  expect(html).not.toContain('data-testid="body-one"')
})

test('hydrates, then a click shows the unrolled list, the constant condition and the element prop stays', async () => {
  const { page, errors } = await open('/')
  await page.getByText('one', { exact: true }).click()
  await page.waitForSelector('[data-testid="tip-one"][data-state="open"]')
  const body = page.locator('[data-testid="body-one"]')
  expect(await body.locator('li').count()).toBe(2)
  expect(await body.locator('a').nth(1).getAttribute('href')).toBe('/inbox')
  expect((await body.locator('li').nth(1).textContent())?.trim()).toBe('1: Inbox')
  expect(await body.locator('u').allTextContents()).toEqual(['shown'])
  expect(await page.locator('[data-testid="content-one"] em.loud').textContent()).toBe('hint')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('the second island: Array.from folded rows, hostile text stays text, the fragment prop renders', async () => {
  const { page, errors } = await open('/')
  await page.getByText('two', { exact: true }).click()
  await page.waitForSelector('[data-testid="tip-two"][data-state="open"]')
  const body = page.locator('[data-testid="body-two"]')
  expect(await body.locator('p').allTextContents()).toEqual(['v1.0.4', 'v1.0.3', 'v1.0.2', 'v1.0.1', '"q" \'a\' </script><b>x</b> & done', 'plain'])
  expect(await body.locator('b').count()).toBe(0)
  expect(await page.locator('[data-testid="content-two"] b').textContent()).toBe('a')
  expect(await page.locator('[data-testid="content-two"] em.plain').textContent()).toBe('frag')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
