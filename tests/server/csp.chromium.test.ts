// F539 (B1): `[csp]` in real Chromium against packages/brust/test/fixtures/csp-app (base path /shop, actions under /shop/rpc,
// a React island calling an action, SPA navigation). Under the enforced hash-only policy nothing brust emits is blocked:
// the inline globals pass by hash, the island hydrates and calls the action, a slow navigation shows the progress bar
// (its styles are a constructable sheet). An app-authored inline <style> is blocked by the base policy and applied once
// `style_src = ["'unsafe-inline'"]`.
// Run alone: `bun test --timeout 300000 tests/server/csp.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/csp-app')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const toml = join(app, 'brust.toml')
const original = readFileSync(toml, 'utf8')
const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
const procs: ReturnType<typeof Bun.spawn>[] = []
let strict = ''
let relaxed = ''
let browser: Browser

/** `brust start` with brust.toml as it is now (`[csp]` is read at start, not baked into the build); its base URL. */
async function start(): Promise<string> {
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  procs.push(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  return `http://${/listening on (\S+)/.exec(log)![1]}`
}

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  strict = await start()
  writeFileSync(toml, `${original}style_src = ["'unsafe-inline'"]\n`)
  try {
    relaxed = await start()
  } finally {
    writeFileSync(toml, original)
  }
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  writeFileSync(toml, original)
  await browser?.close()
  for (const p of procs) {
    p.kill('SIGINT')
    if ((await Promise.race([p.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      p.kill('SIGKILL')
      await p.exited
    }
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  rmSync(join(app, '.brust'), { recursive: true, force: true })
})

type Violation = { directive: string; blocked: string; sample: string }
declare global { interface Window { __csp: Violation[]; __bars: number } }

/** A page that records every CSP violation (the event, and Chromium's console report) and every progress bar inserted. */
async function open(url: string): Promise<{ page: Page; console: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const console: string[] = []
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) console.push(m.text()) })
  page.on('pageerror', (e) => console.push(`pageerror: ${e}`))
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }))
    window.__bars = 0
    new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if ((n as Element).matches?.('div[data-brust-bar]')) window.__bars++ }).observe(document, { childList: true, subtree: true })
  })
  const res = await page.goto(url)
  expect(res?.status()).toBe(200)
  return { page, console, close: () => ctx.close() }
}

test('the enforced policy blocks nothing brust emits: inline globals by hash, island + action, SPA nav with the progress bar', async () => {
  const res = await fetch(`${strict}/shop`)
  const policy = res.headers.get('content-security-policy') ?? ''
  expect(policy).toStartWith("default-src 'self'; script-src 'self' 'sha256-")
  expect(policy).toContain("style-src-elem 'self';")
  // two inline scripts (base path, actions prefix), each listed by hash
  expect((await res.text()).match(/<script>/g)?.length).toBe(2)
  expect(policy.match(/'sha256-/g)?.length).toBe(2)

  const { page, console, close } = await open(`${strict}/shop`)
  try {
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    await page.click('[data-testid=echo]')
    await page.waitForFunction(() => document.querySelector('[data-testid=out]')?.textContent?.includes('echo'))
    expect(await page.textContent('[data-testid=out]')).toBe('{"echo":"hi"}')
    await page.evaluate(() => { (window as unknown as { __mark: number }).__mark = 1 })
    await page.click('#to-slow')
    await page.waitForSelector('div[data-brust-bar]', { state: 'attached', timeout: 5_000 })
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('div[data-brust-bar]')!).position)).toBe('fixed')
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('div[data-brust-bar]')!).backgroundColor)).toBe('rgb(47, 124, 246)')
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'csp slow')
    // a SPA navigation, not a reload
    expect(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark)).toBe(1)
    expect(await page.evaluate(() => window.__bars)).toBe(1)
    await page.click('#to-home')
    await page.waitForSelector('brust-island[data-hydrated="1"]', { state: 'attached', timeout: 15_000 })
    expect(await page.evaluate(() => window.__csp)).toEqual([])
    expect(console).toEqual([])
  } finally {
    await close()
  }
}, 60_000)

test("an inline app <style> is blocked by the base policy and applied with style_src = ['unsafe-inline']", async () => {
  const blocked = await open(`${strict}/shop/styled`)
  try {
    expect(await blocked.page.evaluate(() => getComputedStyle(document.getElementById('painted')!).color)).not.toBe('rgb(1, 2, 3)')
    const v = await blocked.page.evaluate(() => window.__csp)
    expect(v.map((x) => x.directive)).toEqual(['style-src-elem'])
    expect(v[0].blocked).toBe('inline')
  } finally {
    await blocked.close()
  }
  expect((await fetch(`${relaxed}/shop/styled`)).headers.get('content-security-policy')).toContain("style-src-elem 'self' 'unsafe-inline';")
  const applied = await open(`${relaxed}/shop/styled`)
  try {
    expect(await applied.page.evaluate(() => getComputedStyle(document.getElementById('painted')!).color)).toBe('rgb(1, 2, 3)')
    expect(await applied.page.evaluate(() => window.__csp)).toEqual([])
    expect(applied.console).toEqual([])
  } finally {
    await applied.close()
  }
}, 60_000)
