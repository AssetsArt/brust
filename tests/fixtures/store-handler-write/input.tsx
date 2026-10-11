import { useStore } from 'brust/store/react'
import { cart } from './cart'

export default function AddToCart({ step }: { step: number }) {
  const s = useStore(cart)
  return (
    <button
      type="button"
      onClick={() => cart.count.set(s.count + step)}
      onDoubleClick={() => {
        const n = s.count * 2
        cart.count.set(n)
      }}
    >
      Add ({s.count})
    </button>
  )
}
