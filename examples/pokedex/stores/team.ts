// examples/pokedex/stores/team.ts — dot-free name (store R3), its own module (compiler R4); NEVER imports lib/team-db.
import { defineStore, signal } from '@brust/core/store'
import { MAX_TEAM } from '../lib/team'
import type { TeamMember } from '../lib/types'

export const team = defineStore('team', () => ({ members: signal<TeamMember[]>([]), max: signal(MAX_TEAM) }))
