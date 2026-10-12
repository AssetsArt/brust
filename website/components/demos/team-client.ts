// The one place demo UI calls the team actions; every reply is written to the store, so every reader updates.
import { client } from '@brust/core/client'
import type { App } from '../../actions'
import { team } from './team-store'

const api = client<App>()

type Reply = { data: { team: { id: number; name: string; sprite: string }[]; max: number } | null; error: { status: unknown } | null }
const apply = (r: Reply): void => {
  if (r.data) {
    team.members.set(r.data.team)
    team.max.set(r.data.max)
  }
}

/** Adds a Pokémon; resolves to an error line for the demo (409 team full, or the status), or '' on success. */
export async function addMember(id: number): Promise<string> {
  const r = await api.team.post({ id })
  if (r.error) return r.error.status === 409 ? `409 · team full (max ${team.max()})` : `failed with status ${String(r.error.status)}`
  apply(r)
  return ''
}

export async function removeMember(id: number): Promise<void> {
  apply(await api.team({ id }).delete())
}
