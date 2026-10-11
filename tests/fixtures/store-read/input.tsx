import { useStore } from 'brust/store/react'
import { cart } from './cart'

export default function CartBadge() {
  const s = useStore(cart)
  return <span className="badge">{s.count}</span>
}
