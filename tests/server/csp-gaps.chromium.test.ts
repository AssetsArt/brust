// F544: `[csp]` with default_src = "none", form_action and connect_src "ws://{host}" in real Chromium against
// packages/brust/test/fixtures/csp-gaps-app (base path /shop, actions under /shop/rpc, a React island calling an action
// and opening a WebSocket on the actions prefix, SPA navigation). Under default-src 'none' brust names what it loads
// itself, so nothing it does is blocked; {host} is the request's own authority; a form posting to another origin is
// blocked by form-action. Then BRUST_CSP_MODE at boot: off, report-only, and a bad value that stops the server.
// Run alone: `bun test --timeout 300000 tests/server/csp-gaps.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/csp-gaps-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', BRUST_CSP_MODE: '', NODE_ENV: 'production' }
const procs: ReturnType<typeof Bun.spawn>[] = []
let base = ''
let browser: Browser

/** `brust start` with `extra` env; its base URL, or the exit code and output when it does not get ready. */
async function start(extra: Record<string, string> = {}): Promise<{ url?: string; code?: number; log: string }> {
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' })
  procs.push(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) return { code: await proc.exited, log: log + (await new Response(proc.stderr as ReadableStream).text()) }
    log += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  return { url: `http://${/listening on (\S+)/.exec(log)![1]}`, log }
}

beforeAll(async () => {
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const s = await start()
  if (!s.url) throw new Error(`brust start failed:\n${s.log}`)
  base = s.url
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      p.kill('SIGKILL')
      await p.exited
    }
  }
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
})

type Violation = { directive: string; blocked: string }
declare global { interface Window { __csp: Violation[]; __mark?: number } }

async function open(url: string): Promise<{ page: Page; console: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const console: string[] = []
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) console.push(m.text()) })
  page.on('pageerror', (e) => console.push(`pageerror: ${e}`))
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI }))
  })
  const res = await page.goto(url)
  expect(res?.status()).toBe(200)
  return { page, console, close: () => ctx.close() }
}

test("the header: default-src 'none' with brust's own directives, form-action, and {host} = the request's authority", async () => {
  const host = new URL(base).host
  const policy = (await fetch(`${base}/shop`)).headers.get('content-security-policy') ?? ''
  expect(policy).toStartWith("default-src 'none'; script-src 'self' 'sha256-")
  expect(policy).toContain(`connect-src 'self' ws://${host};`)
  expect(policy).toContain("img-src 'self';")
  expect(policy).toContain("font-src 'self';")
  expect(policy).toContain("form-action 'self' https://pay.example")
  // a Host the grammar refuses is never echoed: the {host} source is dropped
  const evil = await new Promise<string>((resolve, reject) => {
    const u = new URL(base)
    const sock = require('node:net').connect(Number(u.port), u.hostname, () => sock.write(`GET /shop HTTP/1.1\r\nHost: evil.example;script-src *\r\nConnection: close\r\n\r\n`))
    let raw = ''
    sock.on('data', (d: Buffer) => { raw += d.toString() })
    sock.on('end', () => resolve(raw))
    sock.on('error', reject)
  })
  const line = evil.split('\r\n').find((l) => l.toLowerCase().startsWith('content-security-policy:')) ?? ''
  expect(line).toContain("connect-src 'self';")
  expect(line).not.toContain('evil')
})

test("default-src 'none': island + action + WebSocket + SPA nav with the progress bar, zero violations", async () => {
  const { page, console, close } = await open(`${base}/shop`)
  try {
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    await page.click('[data-testid=echo]')
    await page.waitForFunction(() => document.querySelector('[data-testid=out]')?.textContent === '{"echo":"hi"}')
    await page.click('[data-testid=ws]')
    await page.waitForFunction(() => document.querySelector('[data-testid=out]')?.textContent === 'ws:pong:ping')
    await page.evaluate(() => { window.__mark = 1 })
    await page.click('#to-slow')
    await page.waitForSelector('div[data-brust-bar]', { state: 'attached', timeout: 5_000 })
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'gaps slow')
    await page.click('#to-home')
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    expect(await page.evaluate(() => window.__mark)).toBe(1)
    expect(await page.evaluate(() => window.__csp)).toEqual([])
    expect(console).toEqual([])
  } finally {
    await close()
  }
}, 60_000)

test("form-action: a post to the app's own actions works, a post to another origin is blocked", async () => {
  // the app's own action ('self'): the post goes through, no violation
  const own = await open(`${base}/shop/forms`)
  try {
    await own.page.click('#own-submit')
    await own.page.waitForFunction(() => document.querySelector('h1')?.textContent === 'posted', undefined, { timeout: 15_000 })
    expect(await own.page.evaluate(() => window.__csp)).toEqual([])
  } finally {
    await own.close()
  }
  // another origin: blocked by form-action, the page stays (submitted from the page: the cancelled navigation would
  // leave a click waiting)
  const other = await open(`${base}/shop/forms`)
  try {
    await other.page.evaluate(() => (document.getElementById('other') as HTMLFormElement).requestSubmit())
    await other.page.waitForFunction(() => window.__csp.length > 0)
    expect(await other.page.evaluate(() => window.__csp.map((v) => v.directive))).toEqual(['form-action'])
    expect(await other.page.evaluate(() => location.pathname)).toBe('/shop/forms')
  } finally {
    await other.close()
  }
}, 60_000)

test('BRUST_CSP_MODE at boot: off sends no policy, report-only sends it report-only, a bad value stops the server', async () => {
  const off = await start({ BRUST_CSP_MODE: 'off' })
  const h = (await fetch(`${off.url}/shop`)).headers
  expect([h.get('content-security-policy'), h.get('content-security-policy-report-only')]).toEqual([null, null])
  const ro = await start({ BRUST_CSP_MODE: 'report-only' })
  const r = (await fetch(`${ro.url}/shop`)).headers
  expect(r.get('content-security-policy')).toBeNull()
  expect(r.get('content-security-policy-report-only')).toStartWith("default-src 'none'; ")
  const bad = await start({ BRUST_CSP_MODE: 'strict' })
  expect(bad.url).toBeUndefined()
  expect(bad.code).not.toBe(0)
  expect(bad.log).toContain('BRUST_CSP_MODE must be one of off, report-only, enforce (got "strict")')
}, 60_000)
