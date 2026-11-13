// F548 in real Chromium against packages/brust/test/fixtures/rc-client-islands:
// - a <Dynamic> slot in three server rows renders a runtime component (compiled after the build) that places the
//   build's listed island `shop/sdk.tsx#Motion`: each row prints an empty host with its own props, the build's island
//   chunk is linked once, each host mounts (createRoot) with its props, data-committed is set, it is interactive;
// - a self-recursive tree whose leaf is a React island: the tree HTML is server-rendered (a template macro), each leaf
//   host is empty with its row's props, and every leaf mounts in the browser.
// - an island whose server render is null (an empty host) and whose client renders content: one mount, data-committed.
// Run alone: `bun test --timeout 180000 tests/server/rc-client-islands.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/rc-client-islands')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
})

declare global { interface Window { __lateMounts?: number } }

const hosts = (html: string, idPrefix: string) =>
  [...html.matchAll(new RegExp(`<brust-island style="display:contents" data-id="(${idPrefix}_[0-9a-f]{8})" x-props='([^']*)'>(.*?)</brust-island>`, 'g'))].map((m) => ({ id: m[1]!, props: m[2]!.replaceAll('&quot;', '"'), inner: m[3]! }))

async function open(path: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`)
  return { page, errors }
}

test('a runtime component places the listed island: empty hosts with their props, one build chunk, each mounts and commits', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const h = hosts(html, 'motion')
  expect(h.map((x) => [JSON.parse(x.props), x.inner])).toEqual([[{ label: 'one' }, ''], [{ label: 'two' }, ''], [{ label: 'three' }, '']])
  expect(html).toContain('<h3>two</h3>') // the runtime component's own HTML is server-rendered
  const chunk = html.match(/<script type="module" src="\/_brust\/client\/react-motion_[0-9a-f]{8}-[0-9a-f]+\.js"><\/script>/g)
  expect(chunk?.length).toBe(1)
  const { page, errors } = await open('/')
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-committed="1"]').length === 3, undefined, { timeout: 15_000 })
  expect(await page.locator('[data-testid=motion]').allTextContents()).toEqual(['one 0', 'two 0', 'three 0'])
  await page.locator('[data-row=r2] [data-testid=motion]').click()
  await page.waitForFunction(() => document.querySelector('[data-row=r2] [data-testid=motion]')?.textContent === 'two 1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('a self-recursive tree stays server HTML; its React leaves are client-only hosts that mount', async () => {
  const html = await (await fetch(`${base}/menu`)).text()
  // the tree is server-rendered: every node's <li>, nested lists included
  for (const id of ['a', 'g', 'g1', 'g2', 'g2x']) expect(html).toContain(`data-node="${id}"`)
  const h = hosts(html, 'leaf')
  expect(h.map((x) => [JSON.parse(x.props), x.inner])).toEqual([[{ label: 'A' }, ''], [{ label: 'G1' }, ''], [{ label: 'G2X' }, '']])
  expect(html).toMatch(/<script type="module" src="\/_brust\/client\/react-leaf_[0-9a-f]{8}-[0-9a-f]+\.js"><\/script>/)
  const { page, errors } = await open('/menu')
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-committed="1"]').length === 3, undefined, { timeout: 15_000 })
  expect(await page.locator('[data-testid=leaf]').allTextContents()).toEqual(['A', 'G1', 'G2X'])
  await page.locator('[data-node=g2x] [data-testid=leaf]').click()
  await page.waitForFunction(() => document.querySelector('[data-node=g2x] [data-testid=leaf]')?.getAttribute('data-on') === '1')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test('an island whose SSR renders null mounts once on its empty host and commits', async () => {
  const html = await (await fetch(`${base}/late`)).text()
  const h = hosts(html, 'late')
  expect(h.map((x) => [JSON.parse(x.props), x.inner])).toEqual([[{ label: 'hello' }, '']])
  const { page, errors } = await open('/late')
  await page.waitForFunction(() => document.querySelector('brust-island[data-committed="1"]') !== null, undefined, { timeout: 15_000 })
  await page.waitForSelector('[data-testid=late]')
  expect(await page.textContent('[data-testid=late]')).toBe('hello')
  await Bun.sleep(300) // a second mount would run the effect again
  expect(await page.evaluate(() => window.__lateMounts)).toBe(1)
  expect(await page.locator('[data-testid=late]').count()).toBe(1)
  expect(await page.evaluate(() => document.querySelectorAll('brust-island[data-hydrated="1"]').length)).toBe(1)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
