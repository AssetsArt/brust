import { defineStore, signal } from 'brust/store'

export const cart = defineStore('cart', () => {
  const count = signal(0)
  return { count }
})
