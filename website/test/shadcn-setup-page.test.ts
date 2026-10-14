// website/test/shadcn-setup-page.test.ts — /docs/guides/shadcn-setup: the guide renders as static, sits after "shadcn/ui and libraries",
// links resolve, and the quoted files are the files of the verified run (docs/transcripts/shadcn-setup-guide-app/).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV, PAGES } from '../lib/nav'
import { build, component, freshOut, HOOK_MS, type Manifest, serve, type Server } from './harness'

let srv: Server | undefined
let manifest: Manifest
let html = ''
const root = join(import.meta.dir, '..', '..')
const app = (f: string) => readFileSync(join(root, 'docs/transcripts/shadcn-init-guide-app', f), 'utf8')
const handApp = (f: string) => readFileSync(join(root, 'docs/transcripts/shadcn-setup-guide-app', f), 'utf8')
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const text = (h: string) => unescape(h.replace(/<[^>]+>/g, ''))

beforeAll(async () => {
  const out = freshOut('shadcn-setup')
  manifest = build('routes.tsx', out)
  srv = await serve(out)
  html = await (await fetch(`${srv.base}/docs/guides/shadcn-setup`)).text()
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('shadcn-setup')
}, HOOK_MS)

test('the page is in React & libraries right after "shadcn/ui and libraries", has its anchors and renders static', () => {
  const guide = NAV.find((g) => g.group === 'React & libraries')!.items.map((i) => i.slug)
  expect(guide[guide.indexOf('shadcn') + 1]).toBe('guides/shadcn-setup')
  expect(PAGES.some((p) => p.slug === 'guides/shadcn-setup')).toBe(true)
  // the group sits right after Guide, in the order the human asked for, and the moved pages keep their slugs
  expect(NAV.map((g) => g.group).slice(0, 2)).toEqual(['Guide', 'React & libraries'])
  expect(guide).toEqual(['react-coverage', 'packages', 'shadcn', 'guides/shadcn-setup'])
  for (const id of ['create', 'init', 'use', 'build', 'dark', 'manual']) expect([id, html.includes(`id="${id}"`), html.includes(`href="#${id}"`)]).toEqual([id, true, true])
  expect(component(manifest, 'ShadcnSetup').tier).toBe('static')
  expect(html).not.toMatch(/§/)
})

test('the quoted files are the files of the verified run', () => {
  const page = text(html)
  const components = app('components.json').trim()
  expect(page).toContain(components)
  expect(page).toContain('"paths": { "@/*": ["./*"] },')
  expect(app('tsconfig.json')).toContain('"paths": { "@/*": ["./*"] },')
  expect(app('tsconfig.json')).not.toContain('baseUrl')
  expect(page).toContain(app('pages/ShadcnPage.tsx').trim())
  expect(page).toContain(app('app.css').split('\n').slice(0, 5).join('\n').trim())
  // "Doing it by hand" quotes the earlier manual run's files, which are the same text
  expect(handApp('components.json').trim()).toBe(components)
  expect(page).toContain(handApp('app.css').split('\n').slice(0, 5).join('\n').trim())
})

test('the one-command step quotes the real run and the version it needs', () => {
  const page = text(html)
  const transcript = readFileSync(join(root, 'docs/transcripts/shadcn-init-guide.md'), 'utf8')
  // every non-blank line of the quoted output is a line of the transcript's run
  const block = page.slice(page.indexOf('$ bunx brust shadcn init'), page.indexOf('It did, in order'))
  expect(block.length).toBeGreaterThan(200)
  for (const line of block.split('\n').map((l) => l.trimEnd()).filter(Boolean)) expect([line, transcript.includes(line)]).toEqual([line, true])
  expect(page).toContain('brust shadcn init')
  expect(page).toContain('2.0.0-alpha.11')
  // the command is a manual-first guide no more: step 2 is the command, the manual steps are last
  expect(page.indexOf('Set up shadcn/ui')).toBeLessThan(page.indexOf('Doing it by hand'))
  expect(app('components.json')).toBe(readFileSync(join(root, 'tests/fixtures/shadcn/components.json'), 'utf8'))
})

test('links resolve and the cited transcript exists', () => {
  for (const href of ['/docs/installation', '/docs/shadcn', '/docs/dev-mode']) {
    expect([href, html.includes(`href="${href}"`)]).toEqual([href, true])
    expect([href, PAGES.some((p) => `/docs/${p.slug}` === href)]).toEqual([href, true])
  }
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/guides/ShadcnSetup.tsx'), 'utf8')
  for (const m of src.matchAll(/(docs\/transcripts\/[\w./-]+\.\w+)/g)) expect([m[1], existsSync(join(root, m[1]!))]).toEqual([m[1], true])
})
