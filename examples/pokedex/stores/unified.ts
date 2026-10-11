// examples/pokedex/stores/unified.ts — the /unified demo store: one counter, three surfaces (M3-F D10).
import { defineStore, signal } from '@brust/core/store'

export const unified = defineStore('unified', () => ({ count: signal(0) }))
