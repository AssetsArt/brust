import { defineStore, signal } from '@brust/core/store'

// Defined in a module that is NOT listed in [build] expose: a runtime component importing it is refused.
export const other = defineStore('other', () => ({ count: signal(0) }))
