// F214 in real Chromium: a page whose own state is read, and whose handler is bound, inside the slot of a native child.
// brust keeps such a page on React (`slot-owner`) instead of printing slot content under the child's host, where the
// runtime would bind it to the CHILD's instance (first-paint mismatch, the page's button never reaching the text).
// Served, the page behaves as React: first paint "no", the page's button flips the text to "yes", and a click on the
// child counts on the child only.
// Run alone: `bun test --timeout 120000 tests/server/slot-owner.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/slot-owner-routes.tsx'
const OUT = '.rows/dist-slot-owner'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport SlotPage from "../repro/slot-owner"\nimport MidPage from "../repro/slot-owner-prop"\nexport const routes = defineRoutes([\n  { path: "/slot", Component: SlotPage },\n  { path: "/mid", Component: MidPage },\n])\n`)
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
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, OUT), { recursive: true, force: true })
})


async function open(path = '/slot') {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-testid=box]') !== null)
  await page.waitForTimeout(500)
  return { page, errors }
}

test('first paint is React\'s, and the page\'s button reaches the text inside the child', async () => {
  const { page, errors } = await open()
  expect(await page.getByTestId('p').textContent()).toBe('no')
  await page.getByRole('button', { name: 'flip' }).click()
  expect(await page.getByTestId('p').textContent()).toBe('yes')
  await page.getByRole('button', { name: 'flip' }).click()
  expect(await page.getByTestId('p').textContent()).toBe('no')
  expect(errors).toEqual([])
  await page.close()
})

test('a click on the child counts on the child only', async () => {
  const { page, errors } = await open()
  await page.getByTestId('p').click()
  expect(await page.getByTestId('box').getAttribute('data-n')).toBe('1')
  expect(await page.getByTestId('p').textContent()).toBe('no')
  expect(errors).toEqual([])
  await page.close()
})

test('a prop the client changes, read in the slot of a native child, follows the page (Mellow F1)', async () => {
  const { page, errors } = await open('/mid')
  expect(await page.getByTestId('p').textContent()).toBe('no')
  await page.getByRole('button', { name: 'flip' }).click()
  expect(await page.getByTestId('p').textContent()).toBe('yes')
  expect(errors).toEqual([])
  await page.close()
})
