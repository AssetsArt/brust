import { defineStore, signal } from 'brust/store'
const prefix = 'shop.'
export const cart = defineStore(prefix + 'cart', () => ({ count: signal(0) }))
