// F147 in real Chromium: a page that binds its own `_h1` / `_h2` next to an inline handler and one forwarded through a
// static child's spread. Served, each element runs its own handler as in React (b +10, s +1, Btn +100) and the chunk
// loads (before the fix it declared `const _h1` twice: a SyntaxError, so no handler ran).
// Run alone: `bun test --timeout 120000 tests/server/handler-names.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const FIXTURE = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const ENTRY = '.rows/handler-names-routes.tsx'
const OUT = '.rows/dist-handler-names'
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  mkdirSync(join(FIXTURE, '.rows'), { recursive: true })
  writeFileSync(join(FIXTURE, ENTRY), `import { defineRoutes } from "@brust/core/routes"\nimport Names from "../repro/handler-names"\nimport Forward from "../repro/handler-names-forward"\nexport const routes = defineRoutes([\n  { path: "/names", Component: Names },\n  { path: "/forward", Component: Forward },\n])\n`)
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

async function open(path: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-testid=p]') !== null)
  await page.waitForTimeout(500)
  return { page, errors }
}

const text = async (page: import('playwright').Page) => (await page.getByTestId('p').textContent())?.replace(/\s+/g, ' ').trim()

test('a page that binds its own _h1 and _h2: each element runs its own handler', async () => {
  const { page, errors } = await open('/names')
  expect(await text(page)).toBe('count 0')
  await page.getByTestId('b').click()
  expect(await text(page)).toBe('count 10')
  await page.getByTestId('s').click()
  expect(await text(page)).toBe('count 11')
  await page.getByTestId('btn').click()
  expect(await text(page)).toBe('count 111')
  expect(errors).toEqual([])
  await page.close()
})

test('a forwarded handler next to the page\'s own _h2 (read on the client)', async () => {
  const { page, errors } = await open('/forward')
  expect(await text(page)).toBe('0 0')
  await page.getByTestId('b').click()
  expect(await text(page)).toBe('10 20')
  await page.getByTestId('btn').click()
  expect(await text(page)).toBe('110 220')
  expect(errors).toEqual([])
  await page.close()
})
