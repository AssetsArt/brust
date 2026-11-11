import { defineStore, signal } from '@brust/core/store'

// No built component reads this store: only `[build] expose` puts it in the worker's store table.
export const wish = defineStore('wish', () => ({ items: signal(0) }))
