// F546 in real Chromium against packages/brust/test/fixtures/rc-island: an island artifact the app builds itself (no
// jinja: its HTML comes from `components.render`, its client registers the hydrate function) in three server rows with
// different props, under an enforced CSP. The server HTML is there before any script, each host hydrates once with its
// own props, data-committed is set, SPA navigation away disposes each host, the page id and batch total reach `render`,
// a warm page asks nothing again, and the page has no CSP violation.
// Run alone: `bun test --timeout 180000 tests/server/rc-island.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/rc-island')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_CSP_MODE: '', NODE_ENV: 'production' }
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

const other = async () => {
  const html = await (await fetch(`${base}/other`)).text()
  return {
    renders: Number(/data-testid="renders">(\d+)</.exec(html)![1]),
    pages: JSON.parse(/data-testid="pages">([^<]*)</.exec(html)![1]!.replaceAll('&quot;', '"')) as Record<string, number>,
  }
}

type Rc = { hydrated: Array<{ label: string }>; disposed: number }
declare global { interface Window { __rcIsl?: Rc; __csp: string[] } }

test('the server HTML: one host per row with its props and the app HTML; render once per distinct props, one page', async () => {
  const res = await fetch(`${base}/`)
  expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  const html = await res.text()
  const hosts = [...html.matchAll(/<brust-island style="display:contents" data-id="isl_counter_v1" x-props='([^']*)'>(.*?)<\/brust-island>/g)]
  expect(hosts.map((m) => m[2])).toEqual([
    `<button type="button" data-testid="rc-isl">it's &lt;a&gt; 0</button>`,
    '<button type="button" data-testid="rc-isl">two 0</button>',
    '<button type="button" data-testid="rc-isl">three 0</button>',
  ])
  expect(hosts[0]![1]).not.toContain("'")
  expect(hosts[0]![1]).not.toContain('<')
  expect(html).toMatch(/<script type="module" src="\/_brust\/rc\/[^/]+\/counter\/isl_counter_v1\.js"><\/script>/)
  const o = await other()
  expect(o.renders).toBe(3)
  expect(Object.values(o.pages)).toEqual([3]) // one page render, total 3
  // a second render of the page: HTML cache hit, no render call
  await fetch(`${base}/`)
  expect((await other()).renders).toBe(3)
})

test('in Chromium: each host hydrates once with its props, commits, is interactive, and SPA nav away disposes it; no CSP violation', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`))
  })
  await page.goto(`${base}/`)
  await page.waitForFunction(() => document.querySelectorAll('brust-island[data-committed="1"]').length === 3, undefined, { timeout: 15_000 })
  expect(await page.evaluate(() => window.__rcIsl!.hydrated.map((p) => p.label))).toEqual(["it's <a>", 'two', 'three'])
  await page.locator('[data-row=r2] [data-testid=rc-isl]').click()
  expect(await page.textContent('[data-row=r2] [data-testid=rc-isl]')).toBe('two 1')
  await page.click('[data-testid=to-other]')
  await page.waitForSelector('[data-testid=renders]')
  expect(await page.evaluate(() => window.__rcIsl!.disposed)).toBe(3)
  expect(await page.evaluate(() => window.__rcIsl!.hydrated.length)).toBe(3)
  expect(await page.evaluate(() => window.__csp)).toEqual([])
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
