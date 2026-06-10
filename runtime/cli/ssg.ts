// SSG route selection — decides which flattened routes can be prerendered to
// static HTML and where each one lands on disk. Pure functions, no fs access;
// the build step consumes the decisions.

/** Structural subset of routes.ts FlatRoute that SSG selection needs. The
 * `routes` array the app's routes module exports satisfies this (build.ts
 * already imports it for CSS/native emit — no introspection endpoint). */
export interface FlatRouteLike {
  /** Full path Rust matches against (e.g. '/', '/docs/intro', '/pokemon/{name}'). */
  fullPath: string
  /** Chain of Route nodes from root to leaf, inclusive. Only the LEAF node
   * can carry sse/websocket (defineRoutes forbids children on those). */
  chain: { sse?: unknown; websocket?: unknown }[]
}

export interface SsgRouteDecision {
  /** Normalized fullPath (trailing slash stripped; '/' stays '/'). */
  fullPath: string
  include: boolean
  reason?: 'dynamic-param' | 'wildcard' | 'sse' | 'websocket'
  outFile: string // 'index.html' | 'docs/intro/index.html' …
}

/** Strip trailing slashes ('/docs/intro/' → '/docs/intro'); root stays '/'. */
function normalizePath(p: string): string {
  let s = p.startsWith('/') ? p : `/${p}`
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** '/' → 'index.html'; '/docs/intro' → 'docs/intro/index.html'. Input must be
 * normalized (no trailing slash). */
function outFileFor(normalized: string): string {
  if (normalized === '/') return 'index.html'
  return `${normalized.slice(1)}/index.html`
}

/** Decide, for every flattened route, whether it can be statically prerendered
 * and which file it maps to. Deterministic: trailing-slash duplicates collapse
 * to one decision (first occurrence wins) and output is sorted by fullPath. */
export function collectStaticPaths(flatRoutes: FlatRouteLike[]): SsgRouteDecision[] {
  const seen = new Set<string>()
  const decisions: SsgRouteDecision[] = []

  for (const route of flatRoutes) {
    const fullPath = normalizePath(route.fullPath)
    if (seen.has(fullPath)) continue
    seen.add(fullPath)

    const leaf = route.chain[route.chain.length - 1]
    let reason: SsgRouteDecision['reason']
    if (/\{[^/]*\}/.test(fullPath)) {
      reason = 'dynamic-param'
    } else if (fullPath.includes('*')) {
      reason = 'wildcard'
    } else if (leaf?.sse != null) {
      reason = 'sse'
    } else if (leaf?.websocket != null) {
      reason = 'websocket'
    }

    const decision: SsgRouteDecision = {
      fullPath,
      include: reason === undefined,
      outFile: outFileFor(fullPath),
    }
    if (reason !== undefined) decision.reason = reason
    decisions.push(decision)
  }

  decisions.sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0))
  return decisions
}
