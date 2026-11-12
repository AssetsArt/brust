// F545 in real Chromium against packages/brust/test/fixtures/island-committed: a React island signals that its tree
// has committed (data-committed="1" and a bubbling `brust:island` event, detail { id, phase: 'committed' }), for the
// hydrated path (hydrateRoot) and the client_only one (createRoot). At the event the island is interactive: a click
// sent from the listener reaches React's handler. The `__Commit` wrapper changes neither markup nor useId ids.
// Run alone: `bun test --timeout 120000 tests/server/island-committed.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/island-committed')
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
  let text = ''
  while (!/\[brust\] ready/.test(text) || !/listening on (\S+)/.test(text)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${text}`)
    text += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(text)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  for (const d of ['dist', '.brust']) rmSync(join(app, d), { recursive: true, force: true })
})

type Seen = { id: string; phase: string; target: string; committed: string | null; hydrated: string | null; text: string }
declare global { interface Window { __seen: Seen[] } }

test('each island fires brust:island { id, phase: committed } once, interactive at that moment; useId and markup unchanged', async () => {
  const ssr = await (await fetch(`${base}/`)).text()
  const ssrIds = /data-testid="ids"[^>]*>([^<]*)</.exec(ssr)?.[1]
  expect(ssrIds).toMatch(/\|/)
  expect(ssr).not.toContain('data-committed')

  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.addInitScript(() => {
    window.__seen = []
    document.addEventListener('brust:island', (e) => {
      const host = e.target as HTMLElement
      const { id, phase } = (e as CustomEvent<{ id: string; phase: string }>).detail
      // at the event the tree has committed: a click from here must reach React's handler
      host.querySelector<HTMLButtonElement>('[data-testid=inc]')?.click()
      window.__seen.push({ id, phase, target: host.getAttribute('data-id')!, committed: host.getAttribute('data-committed'), hydrated: host.getAttribute('data-hydrated'), text: host.textContent ?? '' })
    })
  })
  await page.goto(`${base}/`)
  await page.waitForFunction(() => window.__seen.length === 2, undefined, { timeout: 15_000 })
  const seen = await page.evaluate(() => window.__seen)
  const counter = seen.find((s) => s.text.includes('inc'))!
  const width = seen.find((s) => s !== counter)!
  for (const s of [counter, width]) {
    expect(s.phase).toBe('committed')
    expect(s.id).toBe(s.target)
    expect(s.committed).toBe('1')
  }
  expect(width.text).toBe('wide')   // client_only: createRoot rendered before the signal
  // the click sent from the listener landed: 2 -> 3
  await page.waitForFunction(() => document.querySelector('[data-testid=n]')?.textContent === '3', undefined, { timeout: 5_000 })
  // useId: the ids the client rendered are the server's (no mismatch, no re-render from scratch)
  expect(await page.textContent('[data-testid=ids]')).toBe(ssrIds!)
  expect(await page.getAttribute('input', 'id')).toBe(ssrIds!.split('|')[0]!)
  // a late listener reads the attribute: every host is committed, and no second event fired
  expect(await page.evaluate(() => [...document.querySelectorAll('brust-island')].map((h) => h.getAttribute('data-committed')))).toEqual(['1', '1'])
  await page.click('[data-testid=inc]')
  await page.waitForFunction(() => document.querySelector('[data-testid=n]')?.textContent === '4')
  expect(await page.evaluate(() => window.__seen.length)).toBe(2)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
