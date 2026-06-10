import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMdDir } from './scan'

function makeContentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'brust-md-scan-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

describe('scanMdDir', () => {
  test('returns files sorted by relPath with posix separators, including nested dirs', () => {
    const dir = makeContentDir({
      'b.md': '# B\n',
      'a.md': '# A\n',
      'query/where.md': '# Where\n',
      'query/select.md': '# Select\n',
      'guide/index.md': '# Guide\n',
    })
    const files = scanMdDir(dir)
    expect(files.map((f) => f.relPath)).toEqual([
      'a.md',
      'b.md',
      'guide/index.md',
      'query/select.md',
      'query/where.md',
    ])
    for (const f of files) {
      expect(f.absPath).toBe(join(dir, f.relPath))
    }
  })

  test('ignores non-md files', () => {
    const dir = makeContentDir({
      'a.md': '# A\n',
      'notes.txt': 'nope',
      'img/logo.svg': '<svg/>',
    })
    expect(scanMdDir(dir).map((f) => f.relPath)).toEqual(['a.md'])
  })

  test('parses frontmatter scalar kinds: quoted/bare strings, numbers, booleans', () => {
    const dir = makeContentDir({
      'page.md': [
        '---',
        'title: "Where Clauses"',
        "subtitle: 'Single quoted'",
        'description: bare string value',
        'order: 3',
        'weight: 1.5',
        'draft: false',
        'published: true',
        '---',
        '# Body here',
        '',
      ].join('\n'),
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({
      title: 'Where Clauses',
      subtitle: 'Single quoted',
      description: 'bare string value',
      order: 3,
      weight: 1.5,
      draft: false,
      published: true,
    })
    expect(file.body).toBe('# Body here\n')
  })

  test('parses one-level nested map via inline braces (nav)', () => {
    const dir = makeContentDir({
      'page.md': [
        '---',
        'title: Intro',
        'nav: { group: "Getting Started", order: 1 }',
        '---',
        'body',
        '',
      ].join('\n'),
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({
      title: 'Intro',
      nav: { group: 'Getting Started', order: 1 },
    })
  })

  test('missing frontmatter -> empty object, body is whole file', () => {
    const dir = makeContentDir({ 'plain.md': '# Just markdown\n\nNo frontmatter.\n' })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({})
    expect(file.body).toBe('# Just markdown\n\nNo frontmatter.\n')
  })

  test('malformed frontmatter throws with <file>:<line>', () => {
    const dir = makeContentDir({
      'bad.md': ['---', 'title: ok', 'this line has no colon', '---', 'body', ''].join('\n'),
    })
    expect(() => scanMdDir(dir)).toThrow(`${join(dir, 'bad.md')}:3`)
  })

  test('unterminated frontmatter throws with file path', () => {
    const dir = makeContentDir({
      'open.md': ['---', 'title: ok', '# never closed', ''].join('\n'),
    })
    expect(() => scanMdDir(dir)).toThrow(join(dir, 'open.md'))
  })

  test('malformed inline nav map throws with <file>:<line>', () => {
    const dir = makeContentDir({
      'badnav.md': ['---', 'nav: { group "Guide" }', '---', 'body', ''].join('\n'),
    })
    expect(() => scanMdDir(dir)).toThrow(`${join(dir, 'badnav.md')}:2`)
  })

  test('tolerates CRLF line endings', () => {
    const dir = makeContentDir({
      'crlf.md': [
        '---',
        'title: "CRLF Page"',
        'nav: { group: "Guide", order: 2 }',
        '---',
        '# Body',
        '',
      ].join('\r\n'),
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({ title: 'CRLF Page', nav: { group: 'Guide', order: 2 } })
    expect(file.body.replaceAll('\r\n', '\n')).toBe('# Body\n')
  })

  test('frontmatter with blank lines inside is fine', () => {
    const dir = makeContentDir({
      'blank.md': ['---', 'title: A', '', 'order: 2', '---', 'body', ''].join('\n'),
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({ title: 'A', order: 2 })
  })

  test('UTF-8 BOM before the opening fence is stripped, not treated as body', () => {
    const dir = makeContentDir({
      'bom.md': `﻿---\ntitle: Bommed\n---\n# Body\n`,
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({ title: 'Bommed' })
    expect(file.body).toBe('# Body\n')
  })

  test('fences tolerate trailing whitespace', () => {
    const dir = makeContentDir({
      'ws.md': ['--- ', 'title: Spaced', '---\t', '# Body', ''].join('\n'),
    })
    const [file] = scanMdDir(dir)
    expect(file.frontmatter).toEqual({ title: 'Spaced' })
    expect(file.body).toBe('# Body\n')
  })

  test('inline map entry with no value throws with file:line', () => {
    const dir = makeContentDir({
      'novalue.md': ['---', 'nav: { group: }', '---', 'body', ''].join('\n'),
    })
    expect(() => scanMdDir(dir)).toThrow(/novalue\.md:2 .*"group" has no value/)
  })
})
