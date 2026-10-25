import { defineStore, signal } from '@brust/core/store'

// `navigation` is the built-in store's name: this is a build error.
export const nav = defineStore('navigation', () => ({ open: signal(false) }))
