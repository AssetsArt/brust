// website/test/release-notes-page.test.ts — /docs/release-notes: every published version has its entry, newest first, the sidebar
// links the page right after Installation, and every cited path exists.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV } from '../lib/nav'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server } from './harness'

let srv: Server | undefined
let manifest: Manifest
let html = ''

beforeAll(async () => {
  const out = freshOut('release-notes')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  html = await (await fetch(`${srv.base}/docs/release-notes`)).text()
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('release-notes')
}, HOOK_MS)

test('the page is in the Guide right after Installation, and answers 200 with its anchors', () => {
  const guide = NAV.find((g) => g.group === 'Guide')!.items.map((i) => i.slug)
  expect(guide[guide.indexOf('installation') + 1]).toBe('release-notes')
  for (const id of ['alpha-7', 'alpha-6', 'earlier']) expect([id, html.includes(`id="${id}"`), html.includes(`href="#${id}"`)]).toEqual([id, true, true])
  expect(html).toContain('href="/docs/release-notes"')
})

test('every published version has an entry and 2.0.0-alpha.7 comes first', () => {
  // the site header also prints the current version, so locate each entry by its own heading / list item
  const at = (v: string) => Math.max(html.indexOf(`id="alpha-${v}"`), html.indexOf(`<strong>2.0.0-alpha.${v}</strong>`))
  for (const v of ['1', '2', '3', '4', '5', '6', '7']) expect([v, at(v) > 0]).toEqual([v, true])
  expect(at('7')).toBeLessThan(at('6'))
  expect(at('6')).toBeLessThan(at('5'))
  expect(at('5')).toBeLessThan(at('4'))
  for (const claim of ['Rest props and JSX spread', 'asChild', 'Pkg.Member', 'Constant children inside an island', 'Components exported by name', 'only the browser runtime it uses', 'Your Tailwind compiles your CSS']) expect([claim, html.includes(claim)]).toEqual([claim, true])
})

test('the upgrade note carries the exact refusal text', () => {
  expect(html).toContain('Rebuild your app after you upgrade')
  expect(html).toContain('[brust] manifest: manifest version 2 unsupported (want 3): rebuild the app with this brust version')
})

test('the page states no internal spec references, is static, and every cited path exists', () => {
  expect(html).not.toMatch(/§/)
  expect(component(manifest, 'ReleaseNotes').tier).toBe('static')
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/ReleaseNotes.tsx'), 'utf8')
  let cites = 0
  for (const m of src.matchAll(/source: [^*]*?((?:crates|packages|docs|tests|scripts)\/[\w./-]+\.\w+)/g)) {
    expect([m[1], existsSync(join(root, m[1]!))]).toEqual([m[1], true])
    cites++
  }
  expect(src.match(/source: /g)?.length ?? 0).toBeGreaterThanOrEqual(10)
  expect(cites).toBeGreaterThanOrEqual(2)
})
