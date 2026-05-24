import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeManifest, readManifest, type McpManifest } from './manifest.ts'

test('manifest: write and read round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    const manifest: McpManifest = {
      version: 1,
      tools: [{
        name: 'foo',
        inputSchema: { type: 'object', properties: {}, required: [] },
        paramOrder: [],
      }],
      resources: [],
    }
    await writeManifest(dir, manifest)
    const out = await readManifest(dir)
    expect(out).toEqual(manifest)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest returns null when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    expect(await readManifest(dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: writeManifest creates .brust/ directory if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await writeManifest(dir, { version: 1, tools: [], resources: [] })
    const out = await readManifest(dir)
    expect(out).not.toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest rejects version mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await Bun.write(join(dir, '.brust', 'mcp-manifest.json'), JSON.stringify({ version: 999, tools: [], resources: [] }))
    await expect(readManifest(dir)).rejects.toThrow(/version mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest rejects malformed JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await Bun.write(join(dir, '.brust', 'mcp-manifest.json'), '{not json')
    await expect(readManifest(dir)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
