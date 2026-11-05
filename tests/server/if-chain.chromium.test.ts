// F511 in real Chromium: a reactive `if / else if / … / else` run lowers to sibling branches printed once each. The
// fixture is the shape that never finished building before: a 38-case switch (one lucide icon per case) in the rows of
// a list that reads a store, plus a store-driven switch of seven arms. The build finishes in budget; the first paint
// shows the right arm per row and per switch; flipping the store shows the right arm, one per place, none twice.
// Run alone: `bun test --timeout 120000 tests/server/if-chain.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { ICONS } from '../../packages/brust/test/fixtures/if-chain/icons'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/if-chain')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
/** The build of this fixture took > 200 s (and the host's swap) before F511; linear, it takes a few seconds. */
const BUILD_BUDGET_MS = 20_000
let buildMs = 0
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const t0 = performance.now()
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  buildMs = performance.now() - t0
  if (b.exitCode !== 0) throw new Error(`brust build failed (${Math.round(buildMs)} ms):\n${b.stderr.toString()}`)
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
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/** Per row (k0..k35): the classes of every svg a user can see (not under a `[hidden]` element). */
const rowIcons = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="row-"]')].map((row) => ({
      key: row.getAttribute('data-testid')!.slice(4),
      on: row.className,
      icons: [...row.querySelectorAll('svg')].filter((s) => s.closest('[hidden]') === null).map((s) => s.getAttribute('class') ?? ''),
    })),
  )

/** The `[data-testid="big"]` arms a user can see: tag and text. */
const bigArms = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[data-testid="big"]')]
      .filter((e) => e.closest('[hidden]') === null)
      .map((e) => `${e.tagName.toLowerCase()}:${e.textContent}`),
  )

const expectRows = async (p: Page, active: string) => {
  const rows = await rowIcons(p)
  expect(rows.map((r) => r.key)).toEqual(ICONS.slice(0, 36).map((_, i) => `k${i}`))
  for (const [i, r] of rows.entries()) {
    expect(r.icons.length, `row k${i}: ${JSON.stringify(r.icons)}`).toBe(1)
    expect(r.icons[0]!.split(/\s+/)).toContain(`lucide-${kebab(ICONS[i]!)}`)
    expect(r.on).toBe(r.key === active ? 'on' : 'off')
  }
}

test('the 38-case switch in store-reactive rows builds within budget, its templates linear', () => {
  expect(buildMs).toBeLessThan(BUILD_BUDGET_MS)
  // Before F511 the row's templates grew 2^n with the cases (21.6 MB at 12 cases); linear, all of them stay small.
  const dir = join(app, 'dist/jinja')
  const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)
  expect(total).toBeLessThan(4 << 20)
})

test('first paint (no script): the right arm per row and per switch, every other arm hidden', async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  const p = await ctx.newPage()
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await expectRows(p, 'k1')
  expect(await bigArms(p)).toEqual(['p:one'])
  await ctx.close()
})

test('flipping the store shows the right arm, one per place, none twice', async () => {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => document.querySelector('[x-data]') !== null)
  await expectRows(p, 'k1')
  expect(await bigArms(p)).toEqual(['p:one'])
  for (const [key, big] of [
    ['k3', 'p:three'],
    ['k6', 'i:other'],
    ['k0', 'p:zero'],
    ['k35', 'i:other'],
  ] as const) {
    await p.locator(`[data-testid="to-${key}"]`).click()
    await p.waitForFunction((k) => document.querySelector(`[data-testid="row-${k}"]`)?.className === 'on', key)
    // the runtime removes the arms that do not show: one `big` element in the DOM, one icon per row
    expect(await p.locator('[data-testid="big"]').count()).toBe(1)
    expect(await bigArms(p)).toEqual([big])
    await expectRows(p, key)
  }
  expect(errors).toEqual([])
  await p.close()
}, 90_000)
