// website/test/reference.test.ts — the reference pages (Cloudflare, Cache adapters, Cookbook): every route answers
// 200, each page is the static tier with no jobs, code blocks come from loaders, an unknown route is 404.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { NAV } from '../lib/nav'
import { build, freshOut, HOOK_MS, serve, type Server } from './harness'

let out = ''
let base = ''
let srv: Server | undefined

interface Manifest {
  components: Record<string, { tier: string; jobs: { kind: string }[] }>
}
let manifest: Manifest

const GROUPS = ['Cloudflare', 'Cache adapters', 'Cookbook']
const PAGES = NAV.filter((g) => GROUPS.includes(g.group)).flatMap((g) => g.items)

beforeAll(async () => {
  out = freshOut('reference')
  // the landing's react demo warns on purpose (hook-unsupported); no reference page may warn
  manifest = build('routes.tsx', out, /^warning hook-unsupported (?!pages\/docs\/)/)
  srv = await serve(out)
  base = srv.base
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('reference')
}, HOOK_MS)

test('the reference group has 12 pages: Cloudflare 3, Cache adapters 4, Cookbook 5', () => {
  expect(PAGES.length).toBe(12)
})

test('every reference route answers 200 with its title, a code block and no stub text', async () => {
  for (const p of PAGES) {
    const r = await fetch(`${base}/docs/${p.slug}`)
    expect([p.slug, r.status]).toEqual([p.slug, 200])
    const html = await r.text()
    expect([p.slug, html.includes(p.title.replace(/&/g, '&amp;'))]).toEqual([p.slug, true])
    expect([p.slug, html.includes('Coming in the content lanes')]).toEqual([p.slug, false])
    expect([p.slug, html.includes('<pre')]).toEqual([p.slug, true])
  }
})

test('every reference page is the static tier with no jobs', () => {
  for (const p of PAGES) {
    // a component id is its file's basename, lower-cased first letter, plus a hash
    const name = p.file.replace(/^.*\//, '').replace(/\.tsx$/, '')
    const prefix = `${name[0]!.toLowerCase()}${name.slice(1)}_`
    const hits = Object.entries(manifest.components).filter(([id]) => id.startsWith(prefix))
    expect([name, hits.length >= 1]).toEqual([name, true])
    for (const [, c] of hits) expect([name, c.tier, c.jobs.length]).toEqual([name, 'static', 0])
  }
})

test('an unknown docs route is 404', async () => {
  expect((await fetch(`${base}/docs/cookbook/no-such-recipe`)).status).toBe(404)
})

// ---- Configuration (docs-config-from-code): configure from code, what only brust.toml sets, response size ----
test('Configuration: the new sections exist with their anchors, and the page links them in its table of contents', async () => {
  const html = await (await fetch(`${base}/docs/configuration`)).text()
  for (const [id, title] of [['code', 'Configure from code'], ['toml-only', 'What only brust.toml sets'], ['size', 'Response size']] as const) {
    expect([id, html.includes(`id="${id}"`)]).toEqual([id, true])
    expect([id, html.includes(title)]).toEqual([id, true])
    expect([id, html.includes(`href="#${id}"`)]).toEqual([id, true])
  }
})

test('Configuration: the server.ts example names every run() field, and the size facts are on the page', async () => {
  const html = await (await fetch(`${base}/docs/configuration`)).text()
  for (const field of ['distDir', 'entry', 'host', 'port', 'workers', 'renderSlots', 'ioThreads', 'callTimeoutMs', 'drainTimeoutMs', 'bootTimeoutMs']) expect([field, html.includes(field)]).toEqual([field, true])
  expect(html).toContain('bun server.ts')
  expect(html).toContain('256 KiB × render slots × workers')
  expect(html).toContain('response too large: 300029 &gt; 262144')
  expect(html).toContain('8 MiB')
  expect(html).not.toContain('{ config }</code>, then')
})

test('Configuration: every `source:` comment cites a file and line that exist in this repo', () => {
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const root = join(import.meta.dir, '..', '..')
  const src = readFileSync(join(import.meta.dir, '..', 'pages/docs/Configuration.tsx'), 'utf8')
  const comments = src.split('\n').filter((l) => l.includes('source:'))
  expect(comments.length).toBeGreaterThanOrEqual(10)
  let cites = 0
  for (const line of comments) {
    for (const m of line.matchAll(/((?:packages|crates|docs)\/[\w./-]+\.\w+)(?::(\d+))?/g)) {
      const file = join(root, m[1]!)
      expect([m[1], existsSync(file)]).toEqual([m[1], true])
      if (m[2]) {
        expect([m[0], Number(m[2]) <= readFileSync(file, 'utf8').split('\n').length]).toEqual([m[0], true])
        cites++
      }
    }
  }
  expect(cites).toBeGreaterThanOrEqual(12)
})
