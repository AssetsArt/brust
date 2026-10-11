import { defineStore, signal } from '@brust/core/store'

export const user = defineStore('user', () => ({ label: signal('anon') }))
