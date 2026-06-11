import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { slugifyHeading } from 'brustjs/routes'
import { extractHeadings, generateSearchIndex } from './search-index.ts'

// ---------------------------------------------------------------------------
// Slug parity — expected ids are copied VERBATIM from a real renderMdPage()
// run (runtime/md/render.ts) over this exact heading set. The live
// integration parity check (rendered page vs index) lands in task 1.7.
// ---------------------------------------------------------------------------

const PARITY_BODY = [
  '# Page Title',
  '',
  '## Using `mdRoutes`',
  '',
  '## Install & Run',
  '',
  '### The **bold** part',
  '',
  '## Options',
  '',
  '### Options',
  '',
  '## Options',
  '',
  '### [Link text](https://example.com)',
  '',
  '## frontmatter.title (v1.2)',
  '',
  '## ครอบจักรวาล non-ascii',
].join('\n')

// h2/h3 ids as rendered by runtime/md/render.ts (h1 "page-title" exists in the
// rendered page and participates in dedupe, but only h2/h3 are indexed).
const PARITY_EXPECTED = [
  { text: 'Using mdRoutes', anchor: 'using-mdroutes' },
  { text: 'Install & Run', anchor: 'install--run' },
  { text: 'The bold part', anchor: 'the-bold-part' },
  { text: 'Options', anchor: 'options' },
  { text: 'Options', anchor: 'options-2' },
  { text: 'Options', anchor: 'options-3' },
  { text: 'Link text', anchor: 'link-text' },
  { text: 'frontmatter.title (v1.2)', anchor: 'frontmattertitle-v12' },
  { text: 'ครอบจักรวาล non-ascii', anchor: '-non-ascii' },
]

describe('slugifyHeading (public brustjs/routes export — the SAME slugger render.ts uses)', () => {
  test('matches the render.ts algorithm on plain text', () => {
    expect(slugifyHeading('Page Title')).toBe('page-title')
    expect(slugifyHeading('  Install & Run  ')).toBe('install--run')
    expect(slugifyHeading('frontmatter.title (v1.2)')).toBe('frontmattertitle-v12')
    expect(slugifyHeading('ครอบจักรวาล non-ascii')).toBe('-non-ascii')
  })
})

describe('extractHeadings', () => {
  test('parity fixture: anchors match real rendered ids', () => {
    expect(extractHeadings(PARITY_BODY)).toEqual(PARITY_EXPECTED)
  })

  test('h1 participates in dedupe even though only h2/h3 are emitted', () => {
    const body = ['# Setup', '', '## Setup', '', '### Setup'].join('\n')
    expect(extractHeadings(body)).toEqual([
      { text: 'Setup', anchor: 'setup-2' },
      { text: 'Setup', anchor: 'setup-3' },
    ])
  })

  test('dedupe suffixes are -2, -3, …', () => {
    const body = ['## Same', '## Same', '## Same'].join('\n')
    expect(extractHeadings(body).map((h) => h.anchor)).toEqual(['same', 'same-2', 'same-3'])
  })

  test('headings inside ``` fences are ignored', () => {
    const body = ['## Real', '', '```md', '## Inside fence', '```', '', '## After'].join('\n')
    expect(extractHeadings(body).map((h) => h.anchor)).toEqual(['real', 'after'])
  })

  test('~~~ fences shield too, and ``` inside ~~~ does not close it', () => {
    const body = ['~~~', '```', '## hidden', '~~~', '## shown'].join('\n')
    expect(extractHeadings(body).map((h) => h.anchor)).toEqual(['shown'])
  })

  test('trailing closing hashes are stripped', () => {
    expect(extractHeadings('## Title ##')).toEqual([{ text: 'Title', anchor: 'title' }])
  })

  test('backticked heading slugs the code text (normalizer)', () => {
    expect(extractHeadings('## Using `mdRoutes`')).toEqual([
      { text: 'Using mdRoutes', anchor: 'using-mdroutes' },
    ])
  })

  test('underscore emphasis drops, intraword snake_case stays (real-render parity)', () => {
    // Expected ids copied from a real renderMdPage() run.
    expect(extractHeadings('## The _em_ part')).toEqual([
      { text: 'The em part', anchor: 'the-em-part' },
    ])
    expect(extractHeadings('## snake_case heading')).toEqual([
      { text: 'snake_case heading', anchor: 'snake_case-heading' },
    ])
    expect(extractHeadings('## __bold__ start')[0]?.anchor).toBe('bold-start')
  })

  test('4-space-indented heading is code, not a heading', () => {
    expect(extractHeadings('    ## not a heading')).toEqual([])
  })
})

describe('generateSearchIndex', () => {
  test('writes [{title, path, headings}] sorted by relPath, index.md → prefix', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docs-search-'))
    writeFileSync(
      path.join(dir, 'index.md'),
      ['---', 'title: Overview', '---', '', '## What is brust'].join('\n'),
    )
    const sub = path.join(dir, 'guides')
    require('node:fs').mkdirSync(sub)
    writeFileSync(
      path.join(sub, 'markdown-pages.md'),
      ['---', 'title: Markdown Pages', '---', '', '## Using `mdRoutes`', '### Frontmatter'].join(
        '\n',
      ),
    )
    // No frontmatter title → file stem fallback.
    writeFileSync(path.join(dir, 'cli.md'), '## Commands\n')

    const out = path.join(dir, 'search-index.json')
    const entries = generateSearchIndex({ contentDir: dir, outFile: out, prefix: '/docs' })

    expect(entries).toEqual([
      { title: 'cli', path: '/docs/cli', headings: [{ text: 'Commands', anchor: 'commands' }] },
      {
        title: 'Markdown Pages',
        path: '/docs/guides/markdown-pages',
        headings: [
          { text: 'Using mdRoutes', anchor: 'using-mdroutes' },
          { text: 'Frontmatter', anchor: 'frontmatter' },
        ],
      },
      {
        title: 'Overview',
        path: '/docs',
        headings: [{ text: 'What is brust', anchor: 'what-is-brust' }],
      },
    ])

    // pretty=false on disk, parses back to the same value.
    const raw = readFileSync(out, 'utf8')
    expect(raw).not.toContain('\n ')
    expect(JSON.parse(raw)).toEqual(entries)
  })

  test('a failed write logs but does not throw (import-time safety)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docs-search-'))
    writeFileSync(path.join(dir, 'index.md'), '## Hi\n')
    // outFile points INTO a regular file → mkdir/write fails.
    const bogus = path.join(dir, 'index.md', 'nope', 'search-index.json')
    expect(() => generateSearchIndex({ contentDir: dir, outFile: bogus })).not.toThrow()
  })
})
