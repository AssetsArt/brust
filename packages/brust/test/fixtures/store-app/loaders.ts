import { cart } from './stores/cart'
import { user } from './stores/user'

export function cartLoader() {
  cart.count.set(3)
  return { x: 1 }
}

export function plainLoader() {
  return { y: 2 }
}

export function bothLoader() {
  cart.count.set(1)
  user.label.set('ann')
  return { z: 3 }
}

export function islandLoader({ req }: { req: { search: Record<string, string> } }) {
  cart.count.set(Number(req.search.n ?? 0))
  return { w: 4 }
}
