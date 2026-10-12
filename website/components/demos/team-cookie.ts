// The demo team's cookie format, shared by website/actions.ts and the page loaders that seed the `team` store
// (kept out of actions.ts so a loader never imports Elysia).
import { byId, displayName, spriteUrl } from '../../lib/pokemon'
import type { TeamMember } from './team-store'

export const MAX_TEAM = 6
export const TEAM_COOKIE = 'brust_docs_team'

export function member(id: number): TeamMember {
  return { id, name: displayName(byId(id)!.name), sprite: spriteUrl(id) }
}

/** The team in a cookie value (`25.1.4`): unknown or repeated ids dropped, at most MAX_TEAM. */
export function teamFromValue(value: string | undefined): TeamMember[] {
  const ids = [...new Set(decodeURIComponent(value ?? '').split('.').map(Number))].filter((id) => byId(id) !== undefined)
  return ids.slice(0, MAX_TEAM).map(member)
}

/** The team in a Cookie request header. */
export function teamFromCookie(header: string | null | undefined): TeamMember[] {
  return teamFromValue((header ?? '').split(/;\s*/).find((c) => c.startsWith(`${TEAM_COOKIE}=`))?.slice(TEAM_COOKIE.length + 1))
}

/** The Set-Cookie value that stores a team for a day. */
export function teamCookie(team: TeamMember[]): string {
  return `${TEAM_COOKIE}=${team.map((m) => m.id).join('.')}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly`
}
