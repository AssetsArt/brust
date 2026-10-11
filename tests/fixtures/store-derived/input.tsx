import { useStore } from 'brust/store/react'
import { cart } from './cart'
import { fmt } from './fmt'

export default function CartTotal({ unit }: { unit: string }) {
  const s = useStore(cart)
  const total = fmt(s.count, unit)
  return <p>{total}</p>
}
