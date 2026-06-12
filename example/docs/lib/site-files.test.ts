import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateSiteFiles } from './site-files.ts'

// A minimal content dir: two grouped pages (out of source order to prove the
// nav.order sort) + one ungrouped index page (group: null → "Overview").
function fixtureContentDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'site-files-'))
  writeFileSync(
    path.join(dir, 'index.md'),
    '---\ntitle: Home\ndescription: The docs root.\nnav: { order: 0 }\n---\n\nbody\n',
  )
  writeFileSync(
    path.join(dir, 'installation.md'),
    '---\ntitle: Installation\ndescription: Get brust installed.\nnav: { group: "Getting Started", order: 2 }\n---\n\nbody\n',
  )
  writeFileSync(
    path.join(dir, 'introduction.md'),
    '---\ntitle: Introduction\ndescription: Why brust exists.\nnav: { group: "Getting Started", order: 1 }\n---\n\nbody\n',
  )
  return dir
}

const SITE = 'https://example.test'

function run(contentDir: string) {
  const publicDir = mkdtempSync(path.join(tmpdir(), 'site-files-out-'))
  const result = generateSiteFiles({ contentDir, publicDir, siteUrl: SITE, prefix: '/docs' })
  return { result, publicDir }
}

describe('generateSiteFiles — sitemap.xml', () => {
  test('lists Home first, then doc pages in nav.order, as absolute <loc>s', () => {
    const { result, publicDir } = run(fixtureContentDir())
    const xml = readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8')
    expect(result?.sitemap).toBe(xml)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    // Order: Home (extraPath '/'), then index (order 0 → /docs), introduction
    // (order 1), installation (order 2).
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(locs).toEqual([
      `${SITE}/`,
      `${SITE}/docs`,
      `${SITE}/docs/introduction`,
      `${SITE}/docs/installation`,
    ])
  })

  test('strips a trailing slash from siteUrl so <loc>s never double up', () => {
    const publicDir = mkdtempSync(path.join(tmpdir(), 'site-files-out-'))
    const result = generateSiteFiles({
      contentDir: fixtureContentDir(),
      publicDir,
      siteUrl: `${SITE}/`,
      prefix: '/docs',
    })
    expect(result?.urls[0]).toBe(`${SITE}/`)
    expect(result?.sitemap.includes(`${SITE}//`)).toBe(false)
  })
})

describe('generateSiteFiles — llms.txt', () => {
  test('llmstxt.org shape: H1, blockquote, H2 group sections with described links', () => {
    const { result, publicDir } = run(fixtureContentDir())
    const txt = readFileSync(path.join(publicDir, 'llms.txt'), 'utf8')
    expect(result?.llms).toBe(txt)
    expect(txt.startsWith('# brust\n\n> ')).toBe(true)
    // Ungrouped index page → "Overview"; grouped pages keep their group name.
    expect(txt).toContain('## Overview')
    expect(txt).toContain('## Getting Started')
    // Links are absolute and carry the description as the `: note`.
    expect(txt).toContain(`- [Introduction](${SITE}/docs/introduction): Why brust exists.`)
    expect(txt).toContain(`- [Installation](${SITE}/docs/installation): Get brust installed.`)
    // Within Getting Started, introduction (order 1) precedes installation (2).
    expect(txt.indexOf('/docs/introduction')).toBeLessThan(txt.indexOf('/docs/installation'))
    // Home (the native landing page) is NOT a documentation entry.
    expect(txt).not.toContain(`(${SITE}/)`)
  })

  test('a page with no description emits a bare link (no trailing colon)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'site-files-'))
    writeFileSync(
      path.join(dir, 'bare.md'),
      '---\ntitle: Bare\nnav: { group: "G", order: 1 }\n---\n\nbody\n',
    )
    const { publicDir } = run(dir)
    const txt = readFileSync(path.join(publicDir, 'llms.txt'), 'utf8')
    // Bare link: closes with `)` + newline, no `: description` note.
    expect(txt).toContain(`- [Bare](${SITE}/docs/bare)\n`)
    expect(txt).not.toContain(`/docs/bare):`)
  })
})

describe('generateSiteFiles — safety', () => {
  test('returns null and does NOT throw when the content dir is missing', () => {
    const publicDir = mkdtempSync(path.join(tmpdir(), 'site-files-out-'))
    const missing = path.join(tmpdir(), 'site-files-does-not-exist-xyz')
    expect(() => generateSiteFiles({ contentDir: missing, publicDir, siteUrl: SITE })).not.toThrow()
  })

  test('XML-escapes an ampersand in a generated url', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'site-files-'))
    mkdirSync(path.join(dir, 'a&b'))
    writeFileSync(
      path.join(dir, 'a&b', 'page.md'),
      '---\ntitle: Amp\nnav: { order: 1 }\n---\n\nbody\n',
    )
    const { result } = run(dir)
    expect(result?.sitemap).toContain('&amp;')
    expect(result?.sitemap).not.toMatch(/<loc>[^<]*[^&]&[^a]/)
  })
})
