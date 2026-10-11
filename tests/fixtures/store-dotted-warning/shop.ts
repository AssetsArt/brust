import { defineStore, signal } from 'brust/store'

export const cart = defineStore('shop.cart', () => {
  const count = signal(0)
  return { count }
})
