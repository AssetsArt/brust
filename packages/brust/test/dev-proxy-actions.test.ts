// F475 lane B: which requests the dev proxy exempts from Bun's idle timeout, and how large a body it admits.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { perBuild, readActionsPrefix } from '../src/dev/bun'
import { PROXY_MAX_BODY_BYTES, underPrefix } from '../src/dev/proxy'

test('underPrefix: the prefix itself and its subtree, not a sibling that shares the spelling', () => {
  expect(underPrefix('/api', '/api')).toBe(true)
  expect(underPrefix('/api/upload', '/api')).toBe(true)
  expect(underPrefix('/apix', '/api')).toBe(false)
  expect(underPrefix('/other/api', '/api')).toBe(false)
  expect(underPrefix('/_brust/action/x', '/_brust/action')).toBe(true)
})

test('underPrefix: the root prefix is everything', () => {
  expect(underPrefix('/', '/')).toBe(true)
  expect(underPrefix('/any/path', '/')).toBe(true)
})

test('the proxy admits bodies up to the largest max_stream_bytes (4 GiB), not Bun\'s 128 MiB default', () => {
  expect(PROXY_MAX_BODY_BYTES).toBe(4 * 1024 ** 3)
  expect(PROXY_MAX_BODY_BYTES).toBeGreaterThan(128 * 1024 ** 2)
})

// F477 N3: the dev view reads the manifest once per build, and a rebuild with another prefix is picked up.
const build = (root: string, name: string, actions: unknown) => {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ actions }))
  return dir
}

test('readActionsPrefix: the manifest prefix, null without actions or a manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'brust-prefix-'))
  try {
    expect(readActionsPrefix(build(root, 'a', { prefix: '/api' }))).toBe('/api')
    expect(readActionsPrefix(build(root, 'b', null))).toBeNull()
    expect(readActionsPrefix(join(root, 'missing'))).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('perBuild: one read per build however many requests; a rebuild with another prefix is picked up', () => {
  const root = mkdtempSync(join(tmpdir(), 'brust-prefix-'))
  try {
    const reads: string[] = []
    const prefix = perBuild<{ dir: string }, string | null>((d) => (reads.push(d), readActionsPrefix(d)))
    const g1 = { dir: build(root, 'g1', { prefix: '/api' }) }
    expect(prefix(null)).toBeNull()
    for (let i = 0; i < 5; i++) expect(prefix(g1)).toBe('/api')
    expect(reads).toEqual([g1.dir])
    const g2 = { dir: build(root, 'g2', { prefix: '/v2/act' }) } // the next build: another child, another dir
    expect(prefix(g2)).toBe('/v2/act')
    expect(prefix(g2)).toBe('/v2/act')
    expect(reads).toEqual([g1.dir, g2.dir])
    // the cached answer is the build's own: it does not re-read a manifest that changed under the same child
    writeFileSync(join(g2.dir, 'manifest.json'), JSON.stringify({ actions: { prefix: '/other' } }))
    expect(prefix(g2)).toBe('/v2/act')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
