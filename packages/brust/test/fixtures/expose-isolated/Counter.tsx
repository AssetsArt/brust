import { useState } from 'react'
import { heavy } from './lib/heavy'
import { bump, cart } from './shop/sdk'

export default function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="b" data-heavy={heavy(n)} onClick={() => { setN(n + 1); bump(); cart.count.set(cart.count() + 1) }}>
      native {n}
    </button>
  )
}
