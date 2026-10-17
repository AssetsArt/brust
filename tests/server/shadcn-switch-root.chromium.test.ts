// switch-provider-chain PR2 (rulings ab903dc5, 7a25d5e0): Radix's Switch.Root on its own compiles without React (the
// trigger binds the Provider's live `checked` on Primitive.button ahead of a spread of its own rest, and gets the Root's
// own scope unchanged). Served and toggled in Chromium, the switch equals React's own render of each state after every
// click (a value printed once, stale, cannot pass: React's render flips).
// Needs the napi addon, Chromium and the shadcn fixture's node_modules (`cd tests/fixtures/shadcn && bun install`): `bun test --timeout 300000 tests/server/shadcn-switch-root.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { FIXTURE, repo } from '../../scripts/shadcn/paths.ts'

const ROWS = join(FIXTURE, '.rows')
const ENTRY = '.rows/switch-root-routes.tsx'
const DIST = '.rows/dist-switch-root'
const bin = join(repo, 'packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let browser: Browser

const fromFixture = <T>(spec: string) => import(Bun.resolveSync(spec, FIXTURE)) as Promise<T>

beforeAll(async () => {
  mkdirSync(ROWS, { recursive: true })
  writeFileSync(
    join(FIXTURE, ENTRY),
    `import { defineRoutes } from "@brust/core/routes"\nimport Root from "../repro/switch-root"\nimport Page from "../pages/switch"\nexport const routes = defineRoutes([\n  { path: "/switch-root", Component: Root },\n  { path: "/switch", Component: Page },\n])\n`,
  )
  const b = Bun.spawnSync([process.execPath, bin, 'build', ENTRY, '--out-dir', DIST], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1', '--dist-dir', DIST, '--entry', ENTRY], { cwd: FIXTURE, env, stdout: 'pipe', stderr: 'inherit' })
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
  if (proc) {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  rmSync(join(FIXTURE, ENTRY), { force: true })
  rmSync(join(FIXTURE, DIST), { recursive: true, force: true })
})

/** The switch button (`role=switch`) as `tag attr=value...` (sorted), brust's own attributes removed; with `thumb`, the
 * shadcn Thumb (`data-slot=switch-thumb`) after it. */
function button(html: string, thumb = false): string {
  const own = (re: RegExp) => {
    const m = re.exec(html)
    return m ? attrs(m[0]) : `(none ${re}) ${html.slice(0, 400)}`
  }
  const b = own(/<button\b[^>]*role="switch"[^>]*>/)
  return thumb ? `${b} | ${own(/<span\b[^>]*data-slot="switch-thumb"[^>]*>/)}` : b
}

function attrs(tag: string): string {
  return [...tag.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)]
    .map((a) => `${a[1]}=${a[2] ?? ''}`)
    .filter((a) => !/^(?:x-|data-id|:)/.test(a))
    .sort()
    .join(' ')
}

/** React's own render of the shadcn Switch (components/ui/switch.tsx, with its Thumb) in state `checked`. */
async function reactShadcn(checked: boolean): Promise<string> {
  const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
  const { createElement } = await fromFixture<typeof import('react')>('react')
  const mod = (await import(join(FIXTURE, 'components/ui/switch.tsx'))) as { Switch: never }
  return button(renderToStaticMarkup(createElement(mod.Switch, { id: 'airplane-mode', defaultChecked: checked })), true)
}

/** React's own render of the Root in state `checked`. */
async function react(checked: boolean): Promise<string> {
  const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
  const { createElement } = await fromFixture<typeof import('react')>('react')
  const { Switch } = await fromFixture<typeof import('radix-ui')>('radix-ui')
  return button(renderToStaticMarkup(createElement(Switch.Root, { id: 'airplane', 'aria-label': 'Airplane Mode', defaultChecked: checked })))
}

test('Switch.Root alone is served without a React island', async () => {
  const html = await (await fetch(`${base}/switch-root`)).text()
  expect(html).not.toContain('brust-island')
  expect(button(html)).toBe(await react(false))
})

test('Switch.Root toggled in Chromium equals React at every step', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/switch-root`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[x-data], [data-hydrated]') !== null)
  for (const next of [true, false, true]) {
    // unstyled, the button has no box: a DOM click (the same click event) instead of a pointer one
    await page.locator('[role=switch]').evaluate((e) => (e as HTMLElement).click())
    const want = next ? 'checked' : 'unchecked'
    await page
      .waitForFunction((w) => document.querySelector('[role=switch]')?.getAttribute('data-state') === w, want, { timeout: 10_000 })
      .catch(async (e) => {
        throw new Error(`step ${want}: ${e.message}\n${button(await page.content())}\n${errors.join("\n")}`)
      })
    expect(button(await page.content())).toBe(await react(next))
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// PR3 (children-rest): the shadcn Switch passes its Thumb as children, which travel in the Root's rest into the trigger
// (F298); the Thumb, handed the context value by the trigger's clone, is linked and follows it.
test('the shadcn switch page is served without a React island', async () => {
  const html = await (await fetch(`${base}/switch`)).text()
  expect(html).not.toContain('brust-island')
  expect(button(html, true)).toBe(await reactShadcn(false))
})

test('the shadcn switch toggled in Chromium equals React (button and Thumb) at every step', async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}/switch`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[x-data], [data-hydrated]') !== null)
  for (const next of [true, false, true]) {
    await page.locator('[role=switch]').click()
    const want = next ? 'checked' : 'unchecked'
    await page
      .waitForFunction((w) => document.querySelector('[data-slot=switch-thumb]')?.getAttribute('data-state') === w, want, { timeout: 10_000 })
      .catch(async (e) => {
        throw new Error(`step ${want}: ${e.message}\n${button(await page.content(), true)}\n${errors.join('\n')}`)
      })
    expect(button(await page.content(), true)).toBe(await reactShadcn(next))
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
