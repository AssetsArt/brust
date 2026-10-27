import { defineStore, signal } from '@brust/core/store'

/** /mood-a seeds 1, /mood-b seeds 2: an /mood-a island hydrating during the navigation must still see 1 (F462). */
export const mood = defineStore('mood', () => ({ v: signal(0) }))
