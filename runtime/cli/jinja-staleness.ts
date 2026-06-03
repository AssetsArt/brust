import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Dirs that never hold authored route/component source — skip them so a stray
// newer .tsx in a build cache or dependency doesn't force a needless recompile.
const IGNORED_DIRS = new Set(['node_modules', '.brust', 'dist', '.git'])

/** Walk `dir` recursively, returning the newest mtime (ms) of any `.tsx` file
 * found, or 0 when there are none. Ignored dirs (build caches, deps) are pruned. */
function newestTsxMtime(dir: string): number {
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
      newest = Math.max(newest, newestTsxMtime(join(dir, entry.name)))
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
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
  return newestTsxMtime(scanRoot) > manifestMtime
}
