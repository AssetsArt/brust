// website/test/dev-mode.test.ts — /docs/dev-mode and the CLI page's new flags (docs-dev-mode): the page and its anchors, the recorded outputs, the tiers, every
// `source:` citation resolving to a file and a line that exist, and the loop demo driven in Chromium (it must follow the rules the page states).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { build, component, freshOut, HOOK_MS, type Manifest, ready, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
let html = ''
let cli = ''

beforeAll(async () => {
  const out = freshOut('dev-mode')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  html = await (await fetch(`${base}/docs/dev-mode`)).text()
  cli = await (await fetch(`${base}/docs/cli`)).text()
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('dev-mode')
}, HOOK_MS)

test('the page has its sections, the table-of-contents entries, the recorded output and the sidebar link', () => {
  for (const id of ['run', 'loop', 'try', 'reloads', 'errors', 'terminal', 'devtools', 'trace', 'safety']) expect([id, html.includes(`id="${id}"`), html.includes(`href="#${id}"`)]).toEqual([id, true, true])
  expect(html).toContain('<h1>Dev mode</h1>')
  expect(html).toContain('href="/docs/dev-mode"')
  // the recorded plain output: a ready line, a css swap and a failed build, and gen 4 after the fix
  for (const t of ['[brust] css public/app.css (no reload)', 'Expected identifier but found end of file', 'ready http://127.0.0.1:4873 gen 4']) expect([t, html.includes(t.replace(/&/g, '&amp;'))]).toEqual([t, true])
  // the shortcut, the panels and the dev-only URLs
  for (const t of ['Alt+Shift+B', '/_brust/dev/traces', '/_brust/dev/meta', 'BRUST_DEV_ALLOWED_HOSTS', 'x-brust-dev', '#__brust_trace']) expect([t, html.includes(t)]).toEqual([t, true])
  for (const panel of ['Page', 'Components', 'Jobs', 'Store', 'Islands', 'Build', 'Requests']) expect([panel, html.includes(`<td>${panel}</td>`)]).toEqual([panel, true])
  expect(html).not.toMatch(/[฀-๿]/)
})

test('the CLI page lists every flag of cli.ts and no longer calls dev Cloudflare-only', () => {
  for (const flag of ['--target bun|cloudflare|static', '--actions-only', '--strict', '--dev', '--wasm-from-source', '--force', '--out-dir', '--dist-dir', '--workers']) expect([flag, cli.includes(flag)]).toEqual([flag, true])
  expect(cli).toContain('href="/docs/dev-mode"')
  expect(cli).toContain('page-only')
  expect(cli).not.toContain('dev is the Cloudflare development loop only')
  expect(cli).not.toContain('there is no watch mode')
  // the usage block is the usage text of cli.ts
  const usage = readFileSync(join(import.meta.dir, '../../packages/brust/src/cli.ts'), 'utf8')
  for (const line of /const USAGE = `usage:\n([\s\S]*?)\n\nConfig precedence/.exec(usage)![1]!.split('\n')) expect([line, cli.includes(line.replaceAll('<', '&lt;').replaceAll('>', '&gt;'))]).toEqual([line, true])
})

test('tiers: the loop demo is native with no jobs, the pages stay static', () => {
  expect(component(manifest, 'DevLoopDemo')).toMatchObject({ tier: 'native', jobs: [] })
  expect(component(manifest, 'DevMode').tier).toBe('static')
  expect(component(manifest, 'Cli').tier).toBe('static')
})

test('every cited source line exists (cli.ts, dev/*.ts, trace.rs, build/index.ts, docs/*.md)', () => {
  const root = join(import.meta.dir, '..', '..')
  let cites = 0
  for (const name of ['DevMode.tsx', 'Cli.tsx']) {
    const src = readFileSync(join(import.meta.dir, '..', 'pages/docs', name), 'utf8')
    // a bare `devtools.ts:105` or `:105` means the file named earlier on the line or, failing that, the page's default
    const SHORT: Record<string, string> = {
      'cli.ts': 'packages/brust/src/cli.ts',
      'bun.ts': 'packages/brust/src/dev/bun.ts',
      'proxy.ts': 'packages/brust/src/dev/proxy.ts',
      'client.ts': 'packages/brust/src/dev/client.ts',
      'devtools.ts': 'packages/brust/src/dev/devtools.ts',
      'tui.ts': 'packages/brust/src/dev/tui.ts',
      'watch.ts': 'packages/brust/src/dev/watch.ts',
      'diag.ts': 'packages/brust/src/dev/diag.ts',
      'trace.rs': 'crates/brust-core/src/trace.rs',
      'index.ts': 'packages/brust/src/build/index.ts',
    }
    for (const line of src.split('\n').filter((l) => /source:|observed:/.test(l))) {
      let file = name === 'Cli.tsx' ? 'packages/brust/src/cli.ts' : ''
      for (const m of line.matchAll(/((?:crates|packages|docs|tests)\/[\w./-]+\.\w+)|(?<![\w/.])([\w-]+\.(?:ts|rs))|:(\d+)(?:-(\d+))?/g)) {
        if (m[1]) file = m[1]
        else if (m[2]) file = SHORT[m[2]] ?? file
        else if (m[3] && file) {
          expect([name, file, existsSync(join(root, file))]).toEqual([name, file, true])
          const n = readFileSync(join(root, file), 'utf8').split('\n').length
          expect([name, file, m[0], Number(m[4] ?? m[3]) <= n]).toEqual([name, file, m[0], true])
          cites++
        }
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(60)
})

test('the loop demo (Chromium): a page edit reloads, a stylesheet edit does not, a syntax error keeps the last good build, the fix takes the next number', async () => {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}/docs/dev-mode`, { waitUntil: 'networkidle' })
  await ready(page, '.switch')
  const t = (id: string) => page.getByTestId(id)
  const read = async () => ({ gen: await t('dl-gen').innerText(), tries: await t('dl-tries').innerText(), status: await t('dl-status').innerText() })
  expect(await read()).toEqual({ gen: 'gen 1', tries: '1', status: 'ready' })
  await t('dl-page').click()
  expect(await until(read, (r) => r.gen === 'gen 2')).toEqual({ gen: 'gen 2', tries: '2', status: 'ready' })
  await t('dl-css').click()
  expect(await until(() => t('dl-what').innerText(), (w) => w.includes('stylesheet swapped'))).toContain('page kept its state')
  expect(await read()).toEqual({ gen: 'gen 2', tries: '2', status: 'ready' })
  expect(await t('dl-log').innerText()).toContain('[brust] css public/app.css (no reload)')
  await t('dl-break').click()
  expect(await until(read, (r) => r.status === 'error')).toEqual({ gen: 'gen 2', tries: '3', status: 'error' })
  expect(await t('dl-log').innerText()).toContain('[brust] error http://127.0.0.1:1337 gen 2 — build Expected identifier but found end of file')
  await t('dl-fix').click()
  expect(await until(read, (r) => r.status === 'ready')).toEqual({ gen: 'gen 4', tries: '4', status: 'ready' })
  expect(await t('dl-log').innerText()).toContain('[brust] ready http://127.0.0.1:1337 gen 4')
  await t('dl-reset').click()
  expect(await until(read, (r) => r.tries === '1')).toEqual({ gen: 'gen 1', tries: '1', status: 'ready' })
  expect(errors).toEqual([])
  await ctx.close()
}, TEST_MS)
