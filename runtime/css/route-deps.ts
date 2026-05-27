import type { CssDep } from './scan-imports.ts'

export interface RouteForCss {
  /** Route.fullPath (e.g. '/' or '/blog/{slug}'). */
  fullPath: string
  /** Absolute path of the route's Component source file. */
  componentSource: string
}

/** Build the route → CSS chunk hrefs map.
 *
 * MVP: direct lookup only. We collect CSS deps from each route's
 * componentSource file (the file that defines the Component used in
 * defineRoutes). Transitive walking into nested components is a future
 * enhancement — for now, users put @import or @apply or co-locate CSS
 * with the route component. */
export function computeRouteChunks(
  routes: RouteForCss[],
  scan: Map<string, CssDep[]>,
  modules: Record<string, { chunk: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of routes) {
    const deps = scan.get(r.componentSource) ?? []
    const chunks = new Set<string>()
    for (const d of deps) {
      const mod = modules[d.path]
      if (mod) chunks.add(mod.chunk)
    }
    out[r.fullPath] = Array.from(chunks).sort()
  }
  return out
}
