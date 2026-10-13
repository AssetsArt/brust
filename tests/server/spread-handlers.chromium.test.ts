// shadcn S1.3 (R34.18-R34.20, F141) in real Chromium: a native page hands `onClick`/`onChange` to shadcn components
// that spread their props onto an element — the real Button (shadcn's own components/ui/button.tsx, asChild branch included, S1.4) and the real Input. The page
// binds each handler itself on the component's element (`x-on-*` to its own member), the components stay static (no
// chunk), and the page's state updates on click, on input and from a row of a list. Run alone:
// `bun test --timeout 120000 tests/server/spread-handlers.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../fixtures/shadcn')
const dist = '.rows/dist-handlers'
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'handlers/routes.tsx', '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', dist, '--entry', 'handlers/routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
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
  rmSync(join(app, dist), { recursive: true, force: true })
})

test('the components stay static and the page owns the handlers', () => {
  const m = JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))
  const tiers = Object.fromEntries(Object.entries(m.components).map(([id, c]: [string, any]) => [id.replace(/_[0-9a-f]+$/, ''), c.tier]))
  expect(tiers).toEqual({ button: 'static', input: 'static', page: 'native' })
})

test('handlers forwarded through a shadcn spread update the page state', async () => {
  const html = await (await fetch(`${base}/`)).text()
  // Never printed: no inline handler, no function source, only the directive naming the page's member.
  expect(html).not.toMatch(/\son(click|change|input)=/i)
  expect(html).not.toContain('=>')
  expect(html).toMatch(/<button data-slot="button" data-variant="default" data-size="default" class="[^"]+" data-testid="inc" x-on-click="_h\d+">/)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/`, { waitUntil: 'load' })
  const count = page.getByTestId('count')
  await page.getByTestId('inc').click()
  await page.getByTestId('inc').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '2')
  await page.getByTestId('dec').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === '1')
  // shadcn Input's onChange is React's: every keystroke (the input event).
  await page.getByTestId('q').pressSequentially('hey')
  await page.waitForFunction(() => document.querySelector('[data-testid="echo"]')?.textContent === 'hey')
  // A row's handler reads its row.
  await page.locator('[data-testid="pick-b"] button').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="echo"]')?.textContent === 'beta')
  await page.locator('[data-testid="pick-a"] button').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="echo"]')?.textContent === 'alpha')
  expect(await count.textContent()).toBe('1')
  expect(await page.locator('[data-testid="pick-a"] button').getAttribute('class')).toContain('hover:bg-accent')
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
