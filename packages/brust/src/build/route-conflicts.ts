// F496: the server's router refuses some pattern sets (`/{*rest}` next to `/{slug}`); without this the build passes and
// the first `brust start` fails. The check is the router's own insertion (`routing/routes.rs` `find_pattern_conflict`,
// through the addon the build already loads): there is no second matcher here.
import type { FlatRoute } from '../routes'
import { BuildError } from './errors'

export interface PatternConflict {
  /** Index into the patterns given of the pattern the router refused. */
  index: number
  /** Index of the earlier pattern it conflicts with, when there is one. */
  withIndex?: number | null
  /** The router's refusal, as `brust start` would print it. */
  message: string
}

export type CheckPatterns = (patterns: string[]) => PatternConflict | null

/** The addon's `checkRoutePatterns` (crates/brust-napi/src/compile.rs `check_route_patterns`). */
export async function nativeCheckPatterns(): Promise<CheckPatterns> {
  const { native } = await import('../native')
  const b = native() as unknown as { checkRoutePatterns?: CheckPatterns }
  if (typeof b.checkRoutePatterns !== 'function')
    throw new BuildError('route-conflict', 'the native addon is older than this build (no checkRoutePatterns): rebuild it')
  return b.checkRoutePatterns.bind(b)
}

/** Fails the build when the server's router would refuse the leaves' patterns. Catch-all (`*`) leaves never enter the
 * router, so they are left out, as the server leaves them out. The error names the route ids. */
export function assertRoutesInstallable(leaves: FlatRoute[], check: CheckPatterns): void {
  const routed = leaves.filter((l) => !l.catchAll)
  const found = check(routed.map((l) => l.pattern))
  if (!found) return
  const at = routed[found.index]
  const partner = found.withIndex != null ? routed[found.withIndex] : undefined
  const who = partner
    ? `routes ${partner.id} (${partner.pattern}) and ${at?.id} (${at?.pattern}) cannot be installed together`
    : `route ${at?.id} (${at?.pattern}) cannot be installed`
  throw new BuildError('route-conflict', `${who}: ${found.message}`)
}
