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
