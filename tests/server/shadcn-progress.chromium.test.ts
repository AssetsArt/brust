// progress-flip (ruling on challenge 2c9522ea, option C): the shadcn Progress (a wrapper over Radix's Progress.Root /
// Indicator, whose Provider hands out `value` through plain module helpers) is a static page, first paint equals React's,
// and a value that changes follows the page's state (the clone's derived members follow props, F319/F320).
// Needs the napi addon and Chromium: `bun test --timeout 300000 tests/server/shadcn-progress.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { FIXTURE, repo } from '../../scripts/shadcn/paths.ts'

const ROWS = join(FIXTURE, '.rows')
const ENTRY = '.rows/progress-flip-routes.tsx'
const DIST = '.rows/dist-progress-flip'
const bin = join(repo, 'packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let browser: Browser

const fromFixture = <T>(spec: string) => import(Bun.resolveSync(spec, FIXTURE)) as Promise<T>

beforeAll(async () => {
  mkdirSync(ROWS, { recursive: true })
  writeFileSync(
    join(FIXTURE, ENTRY),
    `import { defineRoutes } from "@brust/core/routes"\nimport Progress from "../pages/progress"\nimport Live from "../repro/progress-live"\nimport LiveRoot from "../repro/progress-live-root"\nexport const routes = defineRoutes([\n  { path: "/progress", Component: Progress },\n  { path: "/live", Component: Live },\n  { path: "/live-root", Component: LiveRoot },\n])\n`,
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

/** The markup of the progress bar (the `role=progressbar` element) as `tag{sorted attrs}` plus children, brust's own wrappers removed. */
function bar(html: string): string {
  const i = html.indexOf('role="progressbar"')
  const start = html.lastIndexOf('<div', i)
  let depth = 0
  let end = start
  for (const m of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) {
      end = start + m.index! + m[0].length
      break
    }
  }
  return html
    .slice(start, end)
    .replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_, tag: string, attrs: string, close: string) => {
      const list = [...attrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)]
        .map((m) => `${m[1]}=${m[1] === 'style' ? (m[2] ?? '').replace(/\s+/g, '').replace(/;$/, '').replace('(-0%)', '(0%)') : (m[2] ?? '')}`)
        .filter((a) => !/^(?:x-|data-id)/.test(a))
        .sort()
      return `<${tag} ${list.join(' ')}${close}>`
    })
}

/** React's own render of the shadcn Progress at `value`. */
async function react(value: number | undefined, className = 'w-[60%]'): Promise<string> {
  const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
  const { createElement } = await fromFixture<typeof import('react')>('react')
  const mod = (await import(join(FIXTURE, 'components/ui/progress.tsx'))) as { Progress: never }
  return bar(renderToStaticMarkup(createElement(mod.Progress, { value, className })))
}

test('progress is a static page: no React island, no component script', async () => {
  const html = await (await fetch(`${base}/progress`)).text()
  expect(html).not.toContain('brust-island')
  expect(html).not.toMatch(/<script[^>]+src=/)
})

test("progress: first paint equals React's own render", async () => {
  const html = await (await fetch(`${base}/progress`)).text()
  expect(bar(html)).toBe(await react(66))
})

/** React's own render of a bare Radix Root with an Indicator at `value`. */
async function reactRoot(value: number | null): Promise<string> {
  const { renderToStaticMarkup } = await fromFixture<typeof import('react-dom/server')>('react-dom/server')
  const { createElement } = await fromFixture<typeof import('react')>('react')
  const { Progress } = await fromFixture<typeof import('radix-ui')>('radix-ui')
  return bar(
    renderToStaticMarkup(
      createElement(Progress.Root, { value, max: 100 }, createElement(Progress.Indicator, { style: { width: '10px' } })),
    ),
  )
}

/** Clicks `go` through `steps` and checks the progress bar equals React's after each one. */
async function follows(path: string, steps: (number | null)[], want: (v: number | null) => Promise<string>, settled: (v: number | null) => string) {
  const served = await (await fetch(`${base}${path}`)).text()
  expect(bar(served)).toBe(await want(13))
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  for (const next of steps) {
    const expected = await want(next)
    await page.getByRole('button', { name: 'go' }).click()
    await page.waitForFunction(settled(next), undefined, { timeout: 10_000 }).catch(async (e) => {
      throw new Error(`step ${next}: ${e.message}\n${bar(await page.content())}`)
    })
    expect(bar(await page.content())).toBe(expected)
  }
  expect(errors).toEqual([])
  await page.close()
}

// The Root's `value` changes on the client, which a server-fed job cannot follow: the page renders with React (the
// build says so with `frozen-prop`), and it must still equal React at every step. Condition 2 of the ruling.
test('the shadcn Progress with a value that changes equals React at every step', async () => {
  await follows('/live', [66, 100, 13], react, (v) => `/translateX\\(-?${100 - (v ?? 0)}%\\)/.test(document.querySelector('[data-slot=progress-indicator]')?.getAttribute('style') ?? '')`)
}, 60_000)

test("a bare Radix Root's value that changes reaches its aria and data attributes, equal to React at every step", async () => {
  await follows('/live-root', [66, 100, null, 13], reactRoot, (v) => `document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ${v === null ? '== null' : `=== '${v}'`}`)
}, 60_000)
