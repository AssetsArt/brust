// switch-provider-chain PR1 (+ F345) in real Chromium, against React hydrating the same page in the same browser:
// Radix Switch's shape in app code (a render prop called with the Provider's own context object, a trigger handing the
// context to a static button before the caller's rest, and a Thumb travelling in that rest). A context value of a state
// Provider must never be pinned in a clone (F345): pinned, the trigger's clone printed `data-state` once and the
// switch stayed `unchecked` after a click. Toggled twice, every observable value equals React (thumb, bare).
// Run alone: `bun test --timeout 120000 tests/server/switch-chain.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { renderPage } from '../../packages/brust/test/fixtures/switch-chain/render'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/switch-chain')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser
let reactJs = ''

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
  if (!r.success) throw new Error(`react reference build failed: ${r.logs.join('\n')}`)
  reactJs = await r.outputs[0]!.text()
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
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** Tag, data-* attributes and leaf text of every element under <main>; brust's `display: contents` wrappers (`<brust-row>`,
 * a row whose root is a condition, `<brust-if>`, a condition over a component, and `<brust-host>`, a specialised
 * component's host) have no box, and `<brust-island>` is the wrapper of a React island (a page that falls back): none
 * is observed. */
const observe = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !['brust-row', 'brust-if', 'brust-host', 'brust-island'].includes(e.localName)).map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}:${e.children.length ? '' : e.textContent}`).join(' '))

async function run(page: string, react: boolean, clicks = ['f', 'box', 'f']): Promise<{ log: string[]; errors: string[] }> {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  if (react) {
    await p.route('http://react.test/**', (route) =>
      route.request().url().endsWith('/app.js')
        ? route.fulfill({ contentType: 'text/javascript', body: reactJs })
        : route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root">${renderPage(page)}</div><script>window.__page = ${JSON.stringify(page)}</script><script src="/app.js"></script></body></html>` }),
    )
    await p.goto('http://react.test/', { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true)
  } else {
    await p.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => document.querySelector('[x-data], [data-hydrated]') !== null)
  }
  await p.waitForTimeout(300)
  const log = [await observe(p)]
  for (const id of clicks) {
    await p.locator(`[data-testid="${id}"]`).click()
    await p.waitForTimeout(150)
    log.push(await observe(p))
  }
  await p.close()
  return { log, errors }
}

const tierOf = (prefix: string) => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  return Object.entries(m.components).find(([k]) => k.startsWith(prefix))![1].tier
}

for (const page of ['thumb', 'bare']) {
  test(`${page}: toggled twice, every observable value equals React hydrating the same page`, async () => {
    const react = await run(page, true, ['box', 'box'])
    const served = await run(page, false, ['box', 'box'])
    expect(react.errors).toEqual([])
    expect(served.errors).toEqual([])
    // React's own toggle, so a value printed once (stale) cannot pass
    expect(react.log.map((l) => /data-state=(\w+)/.exec(l)?.[1])).toEqual(['unchecked', 'checked', 'unchecked'])
    expect(served.log).toEqual(react.log)
  }, 90_000)
}
