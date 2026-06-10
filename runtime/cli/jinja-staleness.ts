import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Dirs that never hold authored route/component source — skip them so a stray
// newer .tsx in a build cache or dependency doesn't force a needless recompile.
const IGNORED_DIRS = new Set(['node_modules', '.brust', 'dist', '.git'])

/** Walk `dir` recursively, returning the newest mtime (ms) of any `.tsx` file
 * found, or 0 when there are none. Ignored dirs (build caches, deps) are pruned. */
function newestTsxMtime(dir: string): number {
  return newestMtimeWithSuffix(dir, '.tsx')
}

/** Walk `dir` recursively for the newest mtime (ms) of files ending in
 * `suffix`, or 0 when there are none. Ignored dirs are pruned. */
function newestMtimeWithSuffix(dir: string, suffix: string): number {
  let newest = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      newest = Math.max(newest, newestMtimeWithSuffix(join(dir, entry.name), suffix))
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      try {
        newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs)
      } catch {
        // file vanished mid-walk — ignore
      }
    }
  }
  return newest
}

/** True when the emitted native templates in `jinjaDir` are missing or older
 * than the authored `.tsx` sources under `scanRoot` — i.e. a boot-time
 * recompile is warranted so `bun run <entry>` (source mode) doesn't require a
 * prior `brust build`, and an edited page is picked up without a stale render.
 *
 * Staleness = the build marker (`_manifest.json`, written last by
 * `emitNativeTemplates`) is absent, OR any source `.tsx` is newer than it. */
export function isJinjaStale(scanRoot: string, jinjaDir: string): boolean {
  const manifestPath = join(jinjaDir, '_manifest.json')
  if (!existsSync(manifestPath)) return true
  let manifestMtime: number
  try {
    manifestMtime = statSync(manifestPath).mtimeMs
  } catch {
    return true
  }
  if (newestTsxMtime(scanRoot) > manifestMtime) return true
  return isMdStale(jinjaDir)
}

// Filename literal kept local (mirrors MD_MANIFEST_FILENAME in md/routes.ts)
// so this boot-path module never pulls the md module graph into md-free apps.
const MD_MANIFEST = 'md-manifest.json'

/** Task 2.9: md pages are also "source" for the emitted templates. The frozen
 * `md-manifest.json` next to `jinjaDir` (e.g. `.brust/`) records every content
 * dir (top-level `contentDir` + optional per-entry override for multi-dir
 * apps); the manifest file itself is the md build marker — `emitMdArtifacts`
 * writes it together with the md `.jinja` templates. Missing or unreadable
 * manifest (no md routes / first boot) → not stale, same behaviour as before. */
function isMdStale(jinjaDir: string): boolean {
  const mdManifestPath = join(dirname(jinjaDir), MD_MANIFEST)
  if (!existsSync(mdManifestPath)) return false
  let mdManifestMtime: number
  let manifest: { contentDir?: unknown; entries?: Array<{ contentDir?: unknown }> }
  try {
    mdManifestMtime = statSync(mdManifestPath).mtimeMs
    manifest = JSON.parse(readFileSync(mdManifestPath, 'utf8'))
  } catch {
    return false
  }
  const contentDirs = new Set<string>()
  if (typeof manifest?.contentDir === 'string') contentDirs.add(manifest.contentDir)
  if (Array.isArray(manifest?.entries)) {
    for (const e of manifest.entries) {
      if (typeof e?.contentDir === 'string') contentDirs.add(e.contentDir)
    }
  }
  for (const dir of contentDirs) {
    if (newestMtimeWithSuffix(dir, '.md') > mdManifestMtime) return true
  }
  return false
}
