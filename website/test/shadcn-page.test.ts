// website/test/shadcn-page.test.ts — /docs/shadcn: the counts and the tables are docs/shadcn-coverage.json, never typed by hand.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import coverage from '../../docs/shadcn-coverage.json'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server } from './harness'

let srv: Server | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('shadcn')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  html = await (await fetch(`${srv.base}/docs/shadcn`)).text()
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('shadcn')
}, HOOK_MS)

test('the summary counts equal the generated JSON', () => {
  const s = coverage.summary
  const count = (id: string) => Number(new RegExp(`data-testid="${id}"[^>]*>(\\d+)<`).exec(html)?.[1])
  expect([count('count-pages'), count('count-measured'), count('count-static'), count('count-native'), count('count-react'), count('count-islands'), count('count-nojs')]).toEqual([
    s.pages, s.measured, s.tier.static, s.tier.native, s.tier.react, s.islands, s.pagesWithNoJs,
  ])
  if (s.analysisOnly > 0) expect(count('count-refused')).toBe(s.analysisOnly)
  else expect(html).toContain('Every page builds.')
  expect(html).toContain(`${s.jsGzipKb.median} KB in the middle`)
})

test('every page of the fixture has its row, with the tier and the size from the JSON', () => {
  const rows = html.match(/data-testid="table-pages"[\s\S]*?<\/table>/)?.[0] ?? ''
  for (const r of coverage.rows) expect([r.id, rows.includes(`<code>${r.id}</code>`)]).toEqual([r.id, true])
  expect((rows.match(/<tr[ >]/g)?.length ?? 0) - 1).toBe(coverage.rows.length)
})

test('the blockers table lists the measured blockers in the JSON order', () => {
  const t = html.match(/data-testid="table-blockers"[\s\S]*?<\/table>/)?.[0] ?? ''
  const codes = [...t.matchAll(/<td><code>([^<]+)<\/code><\/td><td>(\d+)<\/td>/g)].map((m) => [m[1], Number(m[2])])
  const want = coverage.blockers
    .filter((b) => b.kind !== 'construct' && b.measuredRows > 0)
    .slice(0, 8)
    .map((b) => [b.blocker.replace(/^(fallback|error):/, ''), b.measuredRows])
  expect(codes).toEqual(want)
})

test('the sections exist, no internal spec references, static, and every cited path exists', () => {
  for (const id of ['compiles', 'islands', 'numbers', 'blockers', 'pages', 'read']) expect([id, html.includes(`id="${id}"`), html.includes(`href="#${id}"`)]).toEqual([id, true, true])
  expect(html).toContain('href="/docs/shadcn"')
  expect(html).not.toMatch(/§/)
  expect(component(manifest, 'Shadcn').tier).toBe('static')
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/Shadcn.tsx'), 'utf8')
  for (const m of src.matchAll(/source: [^*]*?((?:crates|packages|docs|tests|scripts|website)\/[\w./-]+\.\w+)/g)) expect([m[1], existsSync(join(root, m[1]!))]).toEqual([m[1], true])
})
