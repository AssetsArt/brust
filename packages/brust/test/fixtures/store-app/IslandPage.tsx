// useReducer => react tier => an ssr job; it reads the cart store the loader seeded.
import { useReducer } from 'react'
import { cart } from './stores/cart'

export default function IslandPage() {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" onClick={bump}>
      island {cart.count()} {n}
    </button>
  )
}
