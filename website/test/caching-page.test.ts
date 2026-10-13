// website/test/caching-page.test.ts — /docs/caching (docs-cache-prefix): the new section and its anchors, the recorded transcripts on the page, the tiers of the
// new pieces, every `source:` citation resolving, and the key playground driven in Chromium (it must agree with the server's rules).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server, TEST_MS, until, WAIT_MS } from './harness'
import transcripts from '../lib/cache-transcripts.json'

let base = ''
let srv: Server | undefined
let browser: Browser | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('caching')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  base = srv.base
  html = await (await fetch(`${base}/docs/caching`)).text()
  browser = await chromium.launch()
}, HOOK_MS)

afterAll(async () => {
  await browser?.close()
  await srv?.stop()
  freshOut('caching')
}, HOOK_MS)

test('the page has the prefix section, its sub-anchors and the table-of-contents entry', () => {
  for (const id of ['prefix', 'grammar', 'examples', 'pitfalls', 'playground']) expect([id, html.includes(`id="${id}"`)]).toEqual([id, true])
  expect(html).toContain('href="#prefix"')
  expect(html).toContain('Split the cache with prefix')
  for (const fn of ['header(name)', 'cookie(name)', 'query(name)', 'param(name)', 'request(host)', 'env(NAME)', 'or(a, b', 'and(a, b', 'concat(a, b', 'eq(a, b)', 'eq(a, b, v)', 'lower(a)', 'uuid()']) expect([fn, html.includes(fn)]).toEqual([fn, true])
  expect(html).toContain('the same rules as the server, evaluated in your browser')
})

test('the recorded transcripts are on the page: every step of every example, with MISS, HIT and BYPASS', () => {
  const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  for (const t of transcripts) for (const s of t.steps) expect([t.id, html.includes(esc(s.output.split('\n')[0]!))]).toEqual([t.id, true])
  for (const o of ['MISS', 'HIT', 'BYPASS']) expect([o, html.includes(`x-brust-cache: ${o}`)]).toEqual([o, true])
  expect(html).toContain('Expressions see the query and the route params decoded')
  expect(html).not.toContain('undecoded')
})

test('tiers: the playground is a React island, the example blocks and the page stay static', () => {
  expect(component(manifest, 'CacheKeyPlayground').tier).toBe('react')
  expect(component(manifest, 'PrefixExample')).toMatchObject({ tier: 'static', jobs: [] })
  expect(component(manifest, 'Caching').tier).toBe('static')
})

test('every cited source line exists (crates/…/key_expr.rs, pipeline.rs, …)', () => {
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/Caching.tsx'), 'utf8')
  // a bare `key_expr.rs:62-68` means the file named in full earlier on the line or, failing that, this one
  const FULL: Record<string, string> = {
    'key_expr.rs': 'crates/brust-core/src/cache/key_expr.rs',
    'pipeline.rs': 'crates/brust-core/src/pipeline.rs',
    'routes.rs': 'crates/brust-core/src/routing/routes.rs',
    'mod.rs': 'crates/brust-core/src/cache/mod.rs',
  }
  let cites = 0
  for (const line of src.split('\n').filter((l) => /source:|observed:/.test(l))) {
    let file = ''
    for (const m of line.matchAll(/((?:crates|packages|docs)\/[\w./-]+\.\w+)|(?<![\w/.])([\w]+\.rs)|:(\d+)(?:-(\d+))?/g)) {
      if (m[1]) file = m[1]
      else if (m[2]) file = FULL[m[2]] ?? ''
      else if (m[3] && file) {
        expect([file, existsSync(join(root, file))]).toEqual([file, true])
        const n = readFileSync(join(root, file), 'utf8').split('\n').length
        expect([file, m[0], Number(m[4] ?? m[3]) <= n]).toEqual([file, m[0], true])
        cites++
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(35)
})

test('the playground (Chromium): presets, a typed expression, a parse error, BYPASS, no page errors', async () => {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
  ctx.setDefaultTimeout(WAIT_MS)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${base}/docs/caching`, { waitUntil: 'networkidle' })
  const out = page.locator('pre.cmd[aria-live]')
  await out.scrollIntoViewIfNeeded()
  // the first preset (language): cookie lang=th -> prefix "th"
  expect(await until(() => out.innerText(), (t) => t.includes('prefix  "th"'))).toContain('prefix  "th"')
  // a typed expression over the same request
  const prefix = page.getByLabel('prefix', { exact: true })
  await prefix.fill("concat('v1:', lower(cookie(lang)), '|', request(host))")
  expect(await until(() => out.innerText(), (t) => t.includes('prefix  "v1:th|example.com"'))).toContain('prefix  "v1:th|example.com"')
  await page.getByLabel('Path and query').fill('/ex/lang?b=2&a=1')
  expect(await until(() => out.innerText(), (t) => t.includes('query   "a=1&b=2"'))).toContain('query   "a=1&b=2"')
  // the server's own parse error
  await prefix.fill('uuid()')
  expect(await until(() => out.innerText(), (t) => t.includes('is non-deterministic and not allowed in cache keys'))).toContain('is non-deterministic and not allowed in cache keys')
  // the plan preset: a session cookie is BYPASS
  await page.getByLabel('Example').selectOption('plan')
  await page.getByLabel('Cookies (a=1; b=2)').fill('session=s1')
  expect(await until(() => out.innerText(), (t) => t.includes('x-brust-cache: BYPASS'))).toContain('x-brust-cache: BYPASS')
  // an ambiguous request
  await page.getByLabel('Cookies (a=1; b=2)').fill('lang=th; Lang=en')
  expect(await until(() => out.innerText(), (t) => t.includes('two names differ only in case'))).toContain('two names differ only in case')
  expect(errors).toEqual([])
  await ctx.close()
}, TEST_MS)
