import { useState } from 'react'
import { cart } from './stores/cart'
import { user } from './stores/user'

export default function BothPage() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => { setN(n + 1); cart.count.set(1); user.label.set('x') }}>
      both {n}
    </button>
  )
}
