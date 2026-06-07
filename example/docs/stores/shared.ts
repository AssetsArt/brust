// One reactive store, shared across runtimes. `defineStore` keys a single instance
// on `window.__BRUST_STORES__['home.demo']`, so the react-free native component and
// the React island below both resolve to the SAME signal — a write in one is seen
// by the other, with no bridge, event bus, or prop-drilling.
import { defineStore, signal } from 'brustjs/store'

export const demoStore = defineStore('home.demo', () => {
  const count = signal(0)
  return { count }
})
