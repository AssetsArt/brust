// F499 in real Chromium: a `switch` whose every case returns lowers like an early-return chain. A stateless one is a
// static page (no runtime script, no island) whose markup equals React's; `===` is strict (the string '1' is not 1); a
// switch on `useState` is a native page whose conditional follows the clicks.
// Run alone: `bun test --timeout 120000 tests/server/switch-return.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/switch-return/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/switch-return')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
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

const tierOf = (prefix: string) => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  return Object.entries(m.components).find(([k]) => k.startsWith(prefix))![1].tier
}
/** The page's own markup: between `<main>` and `</main>`, without brust's bookkeeping comments. */
const mainOf = (html: string) =>
  /<main[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!.replace(/<!--[\s\S]*?-->/g, '').replace(/<brust-[a-z]+[^>]*>|<\/brust-[a-z]+>/g, '')

for (const page of ['static', 'strict']) {
  test(`${page}: a stateless switch is a static page, its markup is React's`, async () => {
    expect(tierOf(`p${page[0]!.toUpperCase()}${page.slice(1)}_`)).toBe('static')
    const html = await (await fetch(`${base}/${page}`)).text()
    expect(html).not.toContain('brust-island')
    // nothing of the page ships a runtime or chunk script: only the nav module a full document always carries
    expect([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/nav/.test(s!))).toEqual([])
    expect(mainOf(html)).toBe(mainOf(renderPage(page)))
  })
}

test("strict: '1' is not 1 and '3' is not 3 (React's own answer)", async () => {
  const html = mainOf(await (await fetch(`${base}/strict`)).text())
  expect([...html.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1])).toEqual(['one', 'other', 'few', 'other', 'other'])
})

test('state: a switch on useState is native and follows the clicks a -> b -> c -> a', async () => {
  expect(tierOf('pState_')).toBe('native')
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  await p.goto(`${base}/state`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => document.querySelector('[x-data], [data-hydrated]') !== null)
  const seen = [await p.locator('[data-testid="go"]').textContent()]
  for (let i = 0; i < 3; i++) {
    await p.locator('[data-testid="go"]').click()
    await p.waitForTimeout(150)
    seen.push(await p.locator('[data-testid="go"]').textContent())
  }
  expect(seen).toEqual(['a', 'b', 'c', 'a'])
  expect(errors).toEqual([])
  await p.close()
}, 90_000)
