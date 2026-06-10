import { describe, expect, test } from 'bun:test'
import { mdTemplateName, mdUrlPath } from './routes'

describe('mdTemplateName', () => {
  test('shape: Md_<sanitized>_<8hex>', () => {
    const name = mdTemplateName('query/where.md')
    expect(name).toMatch(/^Md_query_where_md_[0-9a-f]{8}$/)
  })

  test('deterministic for the same relPath', () => {
    expect(mdTemplateName('query/where.md')).toBe(mdTemplateName('query/where.md'))
  })

  test('sanitize-collisions differ by hash (a-b.md vs a_b.md)', () => {
    const a = mdTemplateName('a-b.md')
    const b = mdTemplateName('a_b.md')
    // identical sanitized stem...
    expect(a.slice(0, -8)).toBe(b.slice(0, -8))
    // ...but distinct hashes
    expect(a).not.toBe(b)
  })
})

describe('mdUrlPath', () => {
  test('index.md at root maps to the prefix itself', () => {
    expect(mdUrlPath('index.md', '/docs')).toBe('/docs')
  })

  test('nested file maps under prefix without extension', () => {
    expect(mdUrlPath('query/where.md', '/docs')).toBe('/docs/query/where')
  })

  test('nested index maps to its directory', () => {
    expect(mdUrlPath('guide/index.md', '/docs')).toBe('/docs/guide')
  })

  test('prefix normalization: trailing slash equals no trailing slash', () => {
    expect(mdUrlPath('query/where.md', '/docs/')).toBe(mdUrlPath('query/where.md', '/docs'))
    expect(mdUrlPath('index.md', '/docs/')).toBe('/docs')
  })

  test('root prefix', () => {
    expect(mdUrlPath('index.md', '/')).toBe('/')
    expect(mdUrlPath('intro.md', '/')).toBe('/intro')
  })
})
