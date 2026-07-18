import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FlatRoute } from '../routes.ts'

export interface AiPageEntry {
  path: string
  params: string[]
  catchAll: boolean
  kind: 'react' | 'native' | 'md'
  shellId: string
  title?: string
  description?: string
}

export interface AiManifest {
  version: 1
  pages: AiPageEntry[]
}

type FlatRouteLeaf = FlatRoute['chain'][number] & { __mdSource?: unknown }

const MANIFEST_PATH = '.brust/ai-manifest.json'

export function extractAiManifest(routes: FlatRoute[]): AiManifest {
  const pages = routes
    .map((r): AiPageEntry => {
      const leaf = r.chain[r.chain.length - 1] as FlatRouteLeaf | undefined
      const path = r.fullPath
      const params = Array.from(path.matchAll(/\{(\*?)([^}]+)\}/g), (m) => m[2])
      const kind: AiPageEntry['kind'] = leaf?.__mdSource
        ? 'md'
        : r.nativeTemplate
          ? 'native'
          : 'react'
      return {
        path,
        params,
        catchAll: r.notFound === true,
        kind,
        shellId: r.shellId,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  return { version: 1, pages }
}

export async function writeManifest(cwd: string, manifest: AiManifest): Promise<void> {
  const path = join(cwd, MANIFEST_PATH)
  await mkdir(join(cwd, '.brust'), { recursive: true })
  await Bun.write(path, JSON.stringify(manifest, null, 2))
}

export async function readManifest(cwd: string): Promise<AiManifest | null> {
  const path = join(cwd, MANIFEST_PATH)
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`ai-manifest.json is malformed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`ai-manifest.json version mismatch (expected 1)`)
  }
  return parsed as AiManifest
}
