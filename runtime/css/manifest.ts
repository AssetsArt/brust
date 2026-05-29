import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Per-CSS-file entry. Side-effect imports (.css) have exports:null;
 * CSS Modules (.module.css) have a flat name→hashed-name map. */
export interface ComponentCssModuleEntry {
  /** Absolute URL path served by Rust (e.g. /_brust/css/components/<sha>.css). */
  chunk: string
  /** Original class name → hashed class name. null for non-module .css. */
  exports: Record<string, string> | null
}

export interface ComponentCssManifest {
  version: 1
  /** Absolute filesystem path of the source .css file → entry. */
  modules: Record<string, ComponentCssModuleEntry>
  /** Route.fullPath → ordered, deduplicated chunk href list. */
  routeChunks: Record<string, string[]>
}

/** Read + validate. Returns null when the file doesn't exist (project has
 * no component CSS — treated as a no-op everywhere). Throws on malformed
 * JSON or version mismatch. */
export async function readComponentCssManifest(
  absolutePath: string,
): Promise<ComponentCssManifest | null> {
  const f = Bun.file(absolutePath)
  if (!(await f.exists())) return null
  const text = await f.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(
      `component-manifest.json is malformed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('component-manifest.json version mismatch (expected 1)')
  }
  return parsed as ComponentCssManifest
}

/** Write to disk. Creates the parent directory if needed. */
export async function writeComponentCssManifest(
  absolutePath: string,
  manifest: ComponentCssManifest,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, JSON.stringify(manifest, null, 2), 'utf-8')
}
