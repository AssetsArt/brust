import { describe, test, expect } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readComponentCssManifest, writeComponentCssManifest, type ComponentCssManifest } from './manifest.ts'

describe('runtime/css/manifest', () => {
  test('round-trip a populated manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'css-manifest-'))
    const file = path.join(dir, 'component-manifest.json')
    const m: ComponentCssManifest = {
      version: 1,
      modules: {
        '/abs/foo.module.css': {
          chunk: '/_brust/css/components/abc12345.css',
          exports: { primary: 'primary_abc1', secondary: 'secondary_abc1' },
        },
        '/abs/bar.css': {
          chunk: '/_brust/css/components/def67890.css',
          exports: null,
        },
      },
      routeChunks: {
        '/': ['/_brust/css/components/abc12345.css'],
        '/blog/{slug}': [
          '/_brust/css/components/abc12345.css',
          '/_brust/css/components/def67890.css',
        ],
      },
    }
    await writeComponentCssManifest(file, m)
    const got = await readComponentCssManifest(file)
    expect(got).toEqual(m)
  })

  test('read returns null when file does not exist', async () => {
    const got = await readComponentCssManifest('/no/such/manifest.json')
    expect(got).toBeNull()
  })

  test('read throws on malformed JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'css-manifest-'))
    const file = path.join(dir, 'manifest.json')
    await Bun.write(file, '{ this is not json')
    await expect(readComponentCssManifest(file)).rejects.toThrow()
  })

  test('read throws on wrong version', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'css-manifest-'))
    const file = path.join(dir, 'manifest.json')
    await Bun.write(file, JSON.stringify({ version: 99, modules: {}, routeChunks: {} }))
    await expect(readComponentCssManifest(file)).rejects.toThrow(/version/)
  })
})
