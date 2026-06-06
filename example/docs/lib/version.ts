// Framework version — sourced from the GitHub releases/tags API (the real, live
// "latest release"), NOT from git or a hardcode (a deployed service has no .git
// and no git binary). Design:
//   - synchronous `version()` for callers — NEVER blocks a request on the network.
//   - a background refresh (fired once at worker boot) updates the cached value
//     from the GitHub tags API; until it lands, callers get the installed
//     `brustjs` package version as the fallback.
//   - if the API is unreachable (offline/rate-limited), the fallback stands — the
//     page always renders.
// Server-only: imported by loaders.ts / actions.ts (Bun worker), never by an
// island bundle, so neither the fetch nor the JSON reaches the browser.
// @ts-expect-error — brustjs ships no type decl for ./package.json; Bun resolves it at runtime.
import pkg from 'brustjs/package.json'

const TAGS_API = 'https://api.github.com/repos/AssetsArt/brust/tags?per_page=1'
const FALLBACK = (pkg as { version: string }).version

// Cached, synchronously readable. Seeded with the installed package version so the
// very first render (before the API responds) is still correct, then upgraded to
// the live latest tag once the background fetch resolves.
let current = FALLBACK

async function refresh(): Promise<void> {
  try {
    const res = await fetch(TAGS_API, {
      headers: { 'User-Agent': 'brust-docs', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return
    const tags = (await res.json()) as Array<{ name?: string }>
    const name = tags[0]?.name
    if (name) current = name.replace(/^v/, '') // tags are `v0.1.39-alpha`; UI prepends `v`
  } catch {
    // offline / rate-limited / timed out → keep the package-version fallback
  }
}

// Fire once at module load (worker boot); never awaited on the request path.
void refresh()

/** The latest release version (without a leading `v`). Always returns immediately. */
export function version(): string {
  return current
}
