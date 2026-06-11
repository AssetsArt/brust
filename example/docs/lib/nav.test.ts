import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mdRoutes } from 'brustjs/routes'
import { buildDocsChrome } from './nav.ts'

// Tmp content-dir pattern from runtime/md/routes.test.ts. Each test gets its
// own dir (mdNav keys its prefix registry by resolved dir, so unique tmp dirs
// keep tests independent); mdRoutes() registers the '/docs' prefix the same
// way routes.tsx does in the app.
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeContentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'brust-docs-nav-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

// Mirrors the real content/ seed: ungrouped Overview (order 0) + two groups.
const FILES: Record<string, string> = {
  'index.md': '---\ntitle: Overview\nnav: { order: 0 }\n---\n# Overview\n',
  'introduction.md':
    '---\ntitle: Introduction\nnav: { group: "Getting Started", order: 1 }\n---\n# Intro\n',
  'routing.md': '---\ntitle: Routing\nnav: { group: "Concepts", order: 1 }\n---\n# Routing\n',
}

function chromeFor(path: string, files: Record<string, string> = FILES) {
  const dir = makeContentDir(files)
  mdRoutes(dir, { prefix: '/docs' })
  return buildDocsChrome(path, dir)
}

describe('buildDocsChrome', () => {
  test('groups follow mdNav order; items carry title/path/active', () => {
    const chrome = chromeFor('/docs/introduction')
    expect(chrome.nav.map((g) => g.group)).toEqual([null, 'Getting Started', 'Concepts'])
    expect(chrome.nav[1].items).toEqual([
      { title: 'Introduction', path: '/docs/introduction', active: true },
    ])
    // active is STRICT path equality — exactly one item active.
    const flat = chrome.nav.flatMap((g) => g.items)
    expect(flat.filter((i) => i.active)).toHaveLength(1)
  })

  test('pager walks the flattened sorted sequence across groups', () => {
    const chrome = chromeFor('/docs/introduction')
    expect(chrome.pager.prev).toEqual({ title: 'Overview', path: '/docs' })
    expect(chrome.pager.next).toEqual({ title: 'Routing', path: '/docs/routing' })
  })

  test('first page has no prev; last page has no next', () => {
    const first = chromeFor('/docs')
    expect(first.pager.prev).toBeUndefined() // member-test gates rendering
    expect(first.pager.next).toEqual({ title: 'Introduction', path: '/docs/introduction' })

    const last = chromeFor('/docs/routing')
    expect(last.pager.prev).toEqual({ title: 'Introduction', path: '/docs/introduction' })
    expect(last.pager.next).toBeUndefined()
  })

  test('unknown path: nothing active, empty pager', () => {
    const chrome = chromeFor('/docs/nope')
    expect(chrome.nav.flatMap((g) => g.items).some((i) => i.active)).toBe(false)
    expect(chrome.pager.prev).toBeUndefined()
    expect(chrome.pager.next).toBeUndefined()
  })

  test('normalizes query string and trailing slash before matching', () => {
    expect(chromeFor('/docs/introduction?q=1').pager.prev).toEqual({
      title: 'Overview',
      path: '/docs',
    })
    expect(
      chromeFor('/docs/routing/')
        .nav.flatMap((g) => g.items)
        .find((i) => i.active)?.path,
    ).toBe('/docs/routing')
  })

  test('returns ONLY nav/pager keys (must not clobber the leaf loader __md)', () => {
    const chrome = chromeFor('/docs')
    expect(Object.keys(chrome).sort()).toEqual(['nav', 'pager'])
  })
})
