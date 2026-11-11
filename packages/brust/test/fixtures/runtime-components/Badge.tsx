import { useStore } from '@brust/core/store/react'
import { cart } from './shop/sdk'

// A BUILT component reading the store a runtime component writes (one store, one exposed module instance).
export default function Badge() {
  const s = useStore(cart)
  return <span data-testid="badge">{s.count}</span>
}
