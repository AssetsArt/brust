import { defineStore, signal } from '@brust/core/store'

export const cart = defineStore('cart', () => ({ count: signal(0) }))
