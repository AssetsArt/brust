// Framework version — single source of truth = the latest git release TAG
// (e.g. `v0.1.39-alpha`), resolved once at server start. Falls back to the
// installed `brustjs` package version when git isn't available (a deployed build
// with no .git). Server-only: imported only by loaders.ts / actions.ts (Bun
// worker), never by an island bundle, so neither git nor the JSON reaches the
// browser. The leading `v` is stripped (the UI renders it as `v{version}`).
// @ts-expect-error — brustjs ships no type decl for ./package.json; Bun resolves it at runtime.
import pkg from 'brustjs/package.json'

function latestGitTag(): string | null {
  try {
    // Highest semver tag, version-sorted (independent of reachability).
    const r = Bun.spawnSync(['git', 'tag', '--sort=-v:refname'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (r.exitCode !== 0) return null
    const first = r.stdout.toString().split('\n')[0]?.trim()
    return first ? first : null
  } catch {
    return null
  }
}

const tag = latestGitTag()
const raw = tag ?? `v${(pkg as { version: string }).version}`

/** Release version WITHOUT the leading `v` (UI prepends it). */
export const VERSION: string = raw.replace(/^v/, '')
