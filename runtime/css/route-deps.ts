import { existsSync } from 'node:fs'
import { scanImports } from '../cli/native-routes-emit.ts'
import type { CssDep } from './scan-imports.ts'

export interface RouteForCss {
  /** Route.fullPath (e.g. '/' or '/blog/{slug}'). */
  fullPath: string
  /** Absolute source files of the route's component CHAIN (root layout → leaf).
   * computeRouteChunks walks the local import graph from each and unions the
   * CSS deps it finds — so a layout's co-located `.module.css` links to every
   * route under it, and a leaf's links only to that route. */
  componentSources: string[]
}

/** Build the route → CSS chunk hrefs map.
 *
 * For each route, BFS the LOCAL import graph rooted at the route's component
 * chain (via {@link scanImports}, same default-import walk islands use) and
 * collect the CSS deps of every reachable file. This means a `.module.css`
 * co-located with the component that imports it is enough — no need to also
 * import it in routes.tsx. Chunks are deduplicated and sorted per route. */
export function computeRouteChunks(
  routes: RouteForCss[],
  scan: Map<string, CssDep[]>,
  modules: Record<string, { chunk: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of routes) {
    const chunks = new Set<string>()
    const seen = new Set<string>()
    const queue = [...r.componentSources]
    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      for (const d of scan.get(file) ?? []) {
        const mod = modules[d.path]
        if (mod) chunks.add(mod.chunk)
      }
      // Follow this file's local (relative) default imports transitively.
      for (const dep of scanImports(file).values()) {
        if (!seen.has(dep)) queue.push(dep)
      }
    }
    out[r.fullPath] = Array.from(chunks).sort()
  }
  return out
}
