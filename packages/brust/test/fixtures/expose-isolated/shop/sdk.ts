import { defineStore, signal } from '@brust/core/store'
import { heavy } from '../lib/heavy'

// How many times this module was evaluated in the page: a second instance would make it 2.
export const instance = ((globalThis as { __shopSdkLoads?: number }).__shopSdkLoads = ((globalThis as { __shopSdkLoads?: number }).__shopSdkLoads ?? 0) + 1)
export let count = 0
export const bump = () => ++count
export const label = () => heavy(count)
export const cart = defineStore('cart', () => ({ count: signal(0) }))
export default function version() {
  return 'sdk-1'
}
