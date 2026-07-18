import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractAiManifest, readManifest, writeManifest, type AiManifest } from './manifest.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'brust-ai-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('extractAiManifest classifies react, native, md, and catch-all pages', () => {
  const routes = [
    {
      fullPath: '/docs',
      shellId: 'L:Docs',
      chain: [{ Component: { name: 'Docs' }, __mdSource: { contentDir: '/docs' } }],
      middleware: [],
      nativeTemplate: 'Docs',
    },
    {
      fullPath: '/about',
      shellId: 'S:About',
      chain: [{ Component: { name: 'About' } }],
      middleware: [],
    },
    {
      fullPath: '/{id}',
      shellId: 'S:ById',
      chain: [{ Component: { name: 'ById' } }],
      middleware: [],
      notFound: true,
    },
  ] as never

  const manifest = extractAiManifest(routes)
  expect(manifest).toEqual({
    version: 1,
    pages: [
      {
        path: '/{id}',
        params: ['id'],
        catchAll: true,
        kind: 'react',
        shellId: 'S:ById',
      },
      {
        path: '/about',
        params: [],
        catchAll: false,
        kind: 'react',
        shellId: 'S:About',
      },
      {
        path: '/docs',
        params: [],
        catchAll: false,
        kind: 'md',
        shellId: 'L:Docs',
      },
    ],
  })
})

test('writeManifest and readManifest round-trip', async () => {
  const manifest: AiManifest = {
    version: 1,
    pages: [
      {
        path: '/docs',
        params: [],
        catchAll: false,
        kind: 'md',
        shellId: 'L:Docs',
        title: 'Docs',
      },
    ],
  }
  await writeManifest(dir, manifest)
  await expect(readManifest(dir)).resolves.toEqual(manifest)
})

test('readManifest returns null when missing', async () => {
  await expect(readManifest(dir)).resolves.toBeNull()
})

test('readManifest rejects malformed JSON', async () => {
  await Bun.write(join(dir, '.brust', 'ai-manifest.json'), '{not json')
  await expect(readManifest(dir)).rejects.toThrow(/malformed/)
})

test('readManifest rejects version mismatch', async () => {
  await Bun.write(join(dir, '.brust', 'ai-manifest.json'), JSON.stringify({ version: 2 }))
  await expect(readManifest(dir)).rejects.toThrow(/version mismatch/)
})
