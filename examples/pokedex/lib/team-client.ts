// examples/pokedex/lib/team-client.ts — the one place UI code mutates the team; every reply is written to the store.
import { team } from '../stores/team'
import { api } from './api'
import type { TeamMember } from './types'

type Reply = { data: { team: TeamMember[]; max: number } | null; error: { status: unknown } | null }
const apply = (r: Reply): void => {
  if (r.data) {
    team.members.set(r.data.team)
    team.max.set(r.data.max)
  }
}
export async function refreshTeam(): Promise<void> {
  apply(await api.team.get())
}
export async function removeMember(id: number): Promise<void> {
  apply(await api.team({ id }).delete())
}
export async function addMember(id: number): Promise<void> {
  const r = await api.team.post({ id })
  if (r.error?.status === 409) return refreshTeam() // someone else filled the team: show the truth
  apply(r)
}
export async function toggleMember(id: number, inTeam: boolean): Promise<void> {
  return inTeam ? removeMember(id) : addMember(id)
}
