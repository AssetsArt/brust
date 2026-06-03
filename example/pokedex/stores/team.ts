// Shared team store — GAP S4 dogfood.
//
// AddToTeamButton and TeamBuilder are two SEPARATE island bundles. A plain
// module-scope store imported by both would be duplicated into two instances
// that never sync. `defineStore` resolves both bundles to ONE instance on
// `window.__BRUST_STORES__['pokedex.team']`, so a write in one island is seen by
// the other — no hand-rolled CustomEvent bus.
import { defineStore, signal } from 'brustjs/store'
import type { TeamMember } from '../lib/types'

export const teamStore = defineStore('pokedex.team', () => {
  const members = signal<TeamMember[]>([])
  return { members }
})
