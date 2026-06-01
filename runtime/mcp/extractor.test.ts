import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractMcpManifest } from './extractor.ts'

const RUNTIME = resolve(import.meta.dir, '..')

async function extractFrom(src: string) {
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const actionsFile = join(dir, 'actions.ts')
  await writeFile(actionsFile, src)
  // routesFile can be a throwaway empty routes module — resources come from
  // the `routes` array, not the file, for these tests.
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  const m = await extractMcpManifest({ actionsFile, routesFile, sourceRoots: [dir], routes: [] })
  return { m, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const SRC = `
import { defineActions } from '${RUNTIME}/index.ts'
import { z } from 'zod'
export const actions = defineActions()
  .post('/notes', ({ body }) => ({ id: 'n-' + (body as { text: string }).text.length }), {
    body: z.object({ text: z.string() }),
    description: 'create a note',
  })
  .get('/notes/{id}', ({ params }) => ({ id: params.id }), {
    query: z.object({ verbose: z.boolean().optional() }),
  })
  .get('/whoami', () => ({ user: null as string | null }))
export type Actions = typeof actions
`

test('extractor: emits one name-sorted tool per endpoint', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    expect(m.tools.map((t) => t.name)).toEqual(['get_notes_by_id', 'get_whoami', 'post_notes'])
    const post = m.tools.find((t) => t.name === 'post_notes')!
    expect(post.method).toBe('POST')
    expect(post.path).toBe('/notes')
    expect(post.description).toBe('create a note')
  } finally {
    await cleanup()
  }
})

test('extractor: post inputSchema nests body from inferred zod type', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const post = m.tools.find((t) => t.name === 'post_notes')!
    expect(post.inputSchema.properties?.body?.properties?.text).toEqual({ type: 'string' })
    // no params/query sub-objects on POST /notes
    expect(post.inputSchema.properties?.params).toBeUndefined()
    expect(post.inputSchema.properties?.query).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('extractor: get with param nests params (required string) + query', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const g = m.tools.find((t) => t.name === 'get_notes_by_id')!
    expect(g.inputSchema.properties?.params).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    })
    expect(g.inputSchema.properties?.query?.type).toBe('object')
    expect(g.inputSchema.properties?.body).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('extractor: no-arg endpoint has empty properties', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const w = m.tools.find((t) => t.name === 'get_whoami')!
    expect(w.inputSchema).toEqual({ type: 'object', properties: {} })
  } finally {
    await cleanup()
  }
})

test('extractor: duplicate tool-name slug throws', async () => {
  // /notes/{id} and /notes/by/id both slug to get_notes_by_id
  const src = `
import { defineActions } from '${RUNTIME}/index.ts'
export const actions = defineActions()
  .get('/notes/{id}', () => ({}))
  .get('/notes/by/id', () => ({}))
export type Actions = typeof actions
`
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const actionsFile = join(dir, 'actions.ts')
  await writeFile(actionsFile, src)
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  try {
    await expect(
      extractMcpManifest({ actionsFile, routesFile, sourceRoots: [dir], routes: [] }),
    ).rejects.toThrow(/duplicate.*tool name|get_notes_by_id/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractor: missing actionsFile yields zero tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  try {
    const m = await extractMcpManifest({ routesFile, sourceRoots: [dir], routes: [] })
    expect(m.tools).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
