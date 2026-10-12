// The demo team store (unified store): read by a native badge, a native picker and a React island; seeded by the
// Actions and Store page loaders from the team cookie, updated in the browser with every action reply.
import { defineStore, signal } from '@brust/core/store'

export interface TeamMember {
  id: number
  name: string
  sprite: string
}

export const team = defineStore('team', () => ({
  members: signal<TeamMember[]>([]),
  max: signal(6),
}))
