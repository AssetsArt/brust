// Cross-island sync bus.
//
// GAP §4: brust has no cross-island shared-state primitive. AddToTeamButton and
// TeamBuilder are two SEPARATE island chunks (each its own Bun.build bundle), so
// a module-scope store imported by both would be DUPLICATED — two instances that
// never see each other. The one thing both chunks genuinely share is the
// `window` object, so we coordinate through a window CustomEvent. This works,
// but it's a hand-rolled workaround for a pattern (cart / team / selection) that
// most apps need. See ../FRAMEWORK-GAPS.md §4.

import type { TeamMember } from '../lib/types'

export const TEAM_EVENT = 'brust-pokedex:team'

export function emitTeam(team: TeamMember[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TeamMember[]>(TEAM_EVENT, { detail: team }))
}

export function onTeam(fn: (team: TeamMember[]) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => fn((e as CustomEvent<TeamMember[]>).detail)
  window.addEventListener(TEAM_EVENT, handler)
  return () => window.removeEventListener(TEAM_EVENT, handler)
}
