// In-process team store — a module-scope Map that lives for the whole server
// process. It is GLOBAL across every request and every visitor: brust ships no
// per-session / request-context primitive, so for this dogfood the team is a
// single shared roster.

import type { TeamMember } from './types'

const team = new Map<number, TeamMember>()
export const MAX_TEAM = 6

export const teamStore = {
  list: (): TeamMember[] => [...team.values()].sort((a, b) => a.addedAt - b.addedAt),

  /** Add a member. Returns `false` when the team is full (and the member is
   *  new); idempotent for a member already on the team. */
  add: (m: Omit<TeamMember, 'addedAt'>): boolean => {
    if (team.has(m.id)) return true
    if (team.size >= MAX_TEAM) return false
    team.set(m.id, { ...m, addedAt: Date.now() })
    return true
  },

  remove: (id: number): void => {
    team.delete(id)
  },

  isFull: (): boolean => team.size >= MAX_TEAM,
}
