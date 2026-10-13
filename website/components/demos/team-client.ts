// The one place demo UI changes the team. This site is a static export (no server at runtime, plan R4/R5), so the
// rules of the Actions page's `POST /team` run here, in the browser: the same cap of 6, the same duplicate and
// remove rules, the same error titles. The team is kept in localStorage; every write goes into the `team` store, so
// every reader updates. A blocked storage (private mode, cleared site data) leaves an in-memory team.
import { byId, displayName, spriteUrl } from '../../lib/pokemon'
import { team, type TeamMember } from './team-store'

export const MAX_TEAM = 6
export const TEAM_KEY = 'brust_docs_team'

export function member(id: number): TeamMember {
  return { id, name: displayName(byId(id)!.name), sprite: spriteUrl(id) }
}

/** The team in a stored value (`25.1.4`): unknown or repeated ids dropped, at most MAX_TEAM. */
export function teamFromValue(value: string | null | undefined): TeamMember[] {
  const ids = [...new Set((value ?? '').split('.').map(Number))].filter((id) => byId(id) !== undefined)
  return ids.slice(0, MAX_TEAM).map(member)
}

export type TeamResult = { ok: true; team: TeamMember[] } | { ok: false; status: 404 | 409; title: 'UnknownPokemon' | 'TeamFull'; detail: string }

/** The add rule of the Actions page's `POST /team`: unknown id 404, already in the team = unchanged, a seventh 409. */
export function addTo(current: TeamMember[], id: number): TeamResult {
  if (!byId(id)) return { ok: false, status: 404, title: 'UnknownPokemon', detail: `no Pokémon #${id} in this demo` }
  if (current.some((m) => m.id === id)) return { ok: true, team: current }
  if (current.length >= MAX_TEAM) return { ok: false, status: 409, title: 'TeamFull', detail: `the team already has ${MAX_TEAM} members` }
  return { ok: true, team: [...current, member(id)] }
}

function read(): string | null {
  try {
    return globalThis.localStorage?.getItem(TEAM_KEY) ?? null
  } catch {
    return null
  }
}

function save(next: TeamMember[]): void {
  team.members.set(next)
  team.max.set(MAX_TEAM)
  try {
    globalThis.localStorage?.setItem(TEAM_KEY, next.map((m) => m.id).join('.'))
  } catch {
    // storage blocked: the team lives in memory until the tab closes
  }
}

let loaded = false

/** Fills the store from localStorage once per page; every team component calls it when it mounts. */
export function loadTeam(): void {
  if (loaded) return
  loaded = true
  team.members.set(teamFromValue(read()))
  team.max.set(MAX_TEAM)
}

/** Adds a Pokémon; resolves to an error line for the demo (`409 TeamFull: …`), or '' on success. */
export async function addMember(id: number): Promise<string> {
  loadTeam()
  const r = addTo(team.members(), id)
  if (!r.ok) return `${r.status} ${r.title}: ${r.detail}`
  save(r.team)
  return ''
}

export async function removeMember(id: number): Promise<void> {
  loadTeam()
  save(team.members().filter((m) => m.id !== id))
}
