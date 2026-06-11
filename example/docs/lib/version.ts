// brustjs version for display on the site. The docs app always runs with
// cwd = example/docs — `bun run dev`/`docs:dev` and the SSG build (the crawl
// boots the dist with that same cwd) both do — and the repo root package.json
// IS brustjs's manifest, two levels up. The static export freezes Home's HTML
// at crawl time, so this resolves to the version being shipped, never a stale
// hardcoded literal. Read once at module load.
import { readFileSync } from 'node:fs'
import path from 'node:path'

function readVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    // fall through — never break a render over a missing/oddly-located manifest
  }
  return 'alpha'
}

/** The current brustjs version string, e.g. `0.1.43-alpha`. */
export const BRUST_VERSION: string = readVersion()
