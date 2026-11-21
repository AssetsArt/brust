import { defineStore, signal } from '@brust/core/store'

export const hh = defineStore('hhStore', () => {
  const count = signal(1)
  return { count, add: () => count.set(count() + 1) }
})
