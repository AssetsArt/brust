// website/test/react-coverage-page.test.ts — /docs/react-coverage: the counts and the rows are docs/react-coverage.json, not typed by hand.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import coverage from '../../docs/react-coverage.json'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server } from './harness'

let srv: Server | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('react-coverage')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  html = await (await fetch(`${srv.base}/docs/react-coverage`)).text()
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('react-coverage')
}, HOOK_MS)

test('the summary counts equal the report', () => {
  const s = coverage.summary
  const count = (id: string) => Number(new RegExp(`data-testid="${id}"[^>]*>(\\d+)<`).exec(html)?.[1])
  expect([count('count-native'), count('count-static'), count('count-island'), count('count-partial'), count('count-na')]).toEqual([s.native, s.static, s.island, s.partial, s['n/a']])
  expect(html).toContain(`${s.entries} entries`)
  expect(s.native + s.static + s.island + s.partial + s.unsupported + s['n/a']).toBe(s.entries)
})

test('every group has its heading, table and anchor, and every entry links to its react.dev page', () => {
  for (const [id, title] of Object.entries(coverage.groups)) {
    expect([id, html.includes(`id="${id}"`), html.includes(`href="#${id}"`), html.includes(title)]).toEqual([id, true, true, true])
  }
  for (const e of coverage.entries) expect([e.name, html.includes(`href="${e.url}"`)]).toEqual([e.name, true])
  const rows = html.match(/<tr[ >]/g)?.length ?? 0
  expect(rows).toBeGreaterThanOrEqual(coverage.entries.length)
})

test('the page states no internal spec references and is static', () => {
  expect(html).not.toMatch(/spec §/)
  expect(component(manifest, 'ReactCoverage').tier).toBe('static')
})
