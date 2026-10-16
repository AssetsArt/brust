// F233 / F257 in real Chromium. A page of components, each binding one of the names brust's client chunk generates on
// its own (runtime imports, the behaviour context, the paint helpers, the handler wrapper's rest parameter, member names)
// as a state, a derived value, a handler or a ref: served, every one counts as in React and the page logs no error
// (before the fix such a chunk failed to parse or read the wrong binding, so the component was dead). And the F257 job
// shapes: a body local named like a prop the job reads off a plain `props` parameter (the job module was a SyntaxError).
// Run alone: `bun test --timeout 180000 tests/server/generated-names.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/generated-names-routes.tsx'
const OUT = '.rows/dist-generated-names'
// The fixture is generated (bun scripts/gen-generated-names.ts) from NAMES in crates/brust-compiler/tests/generated_names.rs;
// scripts/gen-generated-names.test.ts fails when this copy differs.
const NAMES = ['signal', 'computed', 'untracked', 'defineBehavior', 'props', '__el', '__effect', '__onCleanup', '__ref', '__text', '__attr', '__attrs', '__attro', '__css', '__unitless', '__bool', '__args', '_c1', '_l1', '_k1', '_p1']
// After one click: the count is 1, the derived value 2 (it doubles the count).
const ROLES: Record<string, string> = { state: '1', derived: '2', handler: '1', ref: '1' }
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport Names from "../repro/generated-names"\nimport Assign from "../repro/f257-assign"\nimport Spread from "../repro/f257-spread"\nexport const routes = defineRoutes([\n  { path: "/names", Component: Names },\n  { path: "/assign", Component: Assign },\n  { path: "/spread", Component: Spread },\n])\n`)
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', OUT], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', OUT, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
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
}, 240_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})

async function open(path: string, ready: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  const res = await page.goto(`${base}${path}`, { waitUntil: 'load' })
  expect(res?.status()).toBe(200)
  await page.waitForFunction((sel) => document.querySelector(sel) !== null, ready)
  await page.waitForTimeout(500)
  return { page, errors }
}

test('a state, a derived value, a handler and a ref named like each generated name: each counts as in React', async () => {
  const { page, errors } = await open('/names', '[data-testid="_p1-ref"]')
  const wrong: string[] = []
  for (const name of NAMES) {
    for (const [role, after] of Object.entries(ROLES)) {
      const box = page.getByTestId(`${name}-${role}`)
      const b = box.locator('b')
      const before = (await b.textContent())?.trim()
      await b.click()
      const now = (await b.textContent())?.trim()
      const show = (await box.getByTestId('show').textContent())?.trim()
      const count = role === 'state' ? now : String(Number(after === '2' ? Number(now) / 2 : now))
      const rows = (await box.locator('li').allTextContents()).join(',')
      const label = await b.getAttribute('aria-label')
      if (before !== '0' || now !== after || show !== count || rows !== `${1 + Number(count)},${2 + Number(count)}` || label !== 'false') {
        wrong.push(`${name} as ${role}: ${before} -> ${now}, show ${show}, rows ${rows}, aria-label ${label}`)
      }
    }
  }
  expect(wrong).toEqual([])
  expect(errors).toEqual([])
  await page.close()
}, 120_000)

for (const [path, label] of [['/assign', 'Object.assign'], ['/spread', 'object spread']]) {
  test(`F257 (${label}): the page renders with the job's style and counts`, async () => {
    const { page, errors } = await open(path, '[data-testid=d]')
    const d = page.getByTestId('d')
    expect(await d.evaluate((e) => (e as HTMLElement).style.color)).toBe('red')
    expect((await d.textContent())?.trim()).toBe('0')
    await d.click()
    expect((await d.textContent())?.trim()).toBe('1')
    expect(errors).toEqual([])
    await page.close()
  })
}
