import { useState } from 'react'
import { bump, cart } from './shop/sdk'

export default function Native() {
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="b" onClick={() => { setN(n + 1); bump(); cart.count.set(cart.count() + 1) }}>
      native {n}
    </button>
  )
}
