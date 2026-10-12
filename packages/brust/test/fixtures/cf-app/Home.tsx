import { useState } from 'react'
import { cart } from './stores/cart'

export default function Home() {
  const [n, setN] = useState(0)
  return (
    <button
      type="button"
      onClick={() => {
        setN(n + 1)
        cart.count.set(cart.count() + 1)
      }}
    >
      cf home {n}
    </button>
  )
}
