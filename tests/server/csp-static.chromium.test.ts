// F541: a `--target static` build of packages/brust/test/fixtures/csp-static-app with [csp] enforced, served the way
// Cloudflare Pages serves it (a path answers its file, <path>.html, or 404.html; the `/*` rule of `_headers` applied),
// in real Chromium. The policy comes from each page's meta: the inline base-path global passes by hash, the island
// hydrates, and an SPA navigation between two static pages and back has zero violations (every page carries the same
// policy, and the head reconcile keeps the one meta).
// Run alone: `bun test --timeout 300000 tests/server/csp-static.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/csp-static-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const out = join(app, 'dist/static')
let server: ReturnType<typeof Bun.serve> | undefined
let base = ''
let browser: Browser

/** The `/*` rule of `_headers` (the only rule this layout needs to honour here). */
function starRule(): Record<string, string> {
  const block = readFileSync(join(out, '_headers'), 'utf8').split('\n\n')[0]!.split('\n')
  if (block[0] !== '/*') return {}
  return Object.fromEntries(block.slice(1).map((l) => [l.trim().slice(0, l.trim().indexOf(':')), l.trim().slice(l.trim().indexOf(':') + 1).trim()]))
}

beforeAll(async () => {
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'static'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build --target static failed:\n${b.stderr.toString()}`)
  const headers = starRule()
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
      for (const f of [rel, `${rel}.html`, `${rel}/index.html`]) {
        if (f.includes('..')) continue
        const p = join(out, f)
        if (existsSync(p) && statSync(p).isFile()) return new Response(Bun.file(p), { headers })
      }
      return new Response(Bun.file(join(out, '404.html')), { status: 404, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
})

type Violation = { directive: string; blocked: string }
declare global { interface Window { __csp: Violation[]; __mark?: number } }

test('a static build under the enforced meta policy: island + SPA nav between static pages, zero violations', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const console: string[] = []
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) console.push(m.text()) })
  page.on('pageerror', (e) => console.push(`pageerror: ${e}`))
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI }))
  })
  try {
    const res = await page.goto(`${base}/site`)
    expect(res?.status()).toBe(200)
    // the policy is the page's own meta, first in <head>; there is no CSP header for this build
    expect(res?.headers()['content-security-policy']).toBeUndefined()
    expect(await page.evaluate(() => document.head.firstElementChild?.outerHTML.startsWith('<meta http-equiv="Content-Security-Policy"'))).toBe(true)
    // the base-path global is an inline script: it ran (allowed by hash)
    expect(await page.evaluate(() => (globalThis as { __BRUST_BASE_PATH__?: string }).__BRUST_BASE_PATH__)).toBe('/site')
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    await page.click('[data-testid=count]')
    await page.waitForFunction(() => document.querySelector('[data-testid=count]')?.textContent === 'count 1')
    await page.evaluate(() => { window.__mark = 1 })
    await page.click('#to-about')
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'static about')
    await page.click('#to-home')
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    // SPA navigations, not reloads; still one policy meta in the head
    expect(await page.evaluate(() => window.__mark)).toBe(1)
    expect(await page.evaluate(() => document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length)).toBe(1)
    expect(await page.evaluate(() => window.__csp)).toEqual([])
    expect(console).toEqual([])
    // and the meta policy is enforced: an inline script no hash covers is blocked
    await page.evaluate(() => {
      const s = document.createElement('script')
      s.textContent = 'globalThis.__ran = 1'
      document.body.append(s)
    })
    await page.waitForFunction(() => window.__csp.length > 0)
    expect(await page.evaluate(() => (globalThis as { __ran?: number }).__ran)).toBeUndefined()
    expect(await page.evaluate(() => window.__csp.map((v) => v.directive))).toEqual(['script-src-elem'])
  } finally {
    await ctx.close()
  }
}, 60_000)

test('the default 404 carries the meta too', async () => {
  const r = await fetch(`${base}/site/nope`)
  expect(r.status).toBe(404)
  expect(await r.text()).toContain('<head><meta http-equiv="Content-Security-Policy" content="default-src')
})
