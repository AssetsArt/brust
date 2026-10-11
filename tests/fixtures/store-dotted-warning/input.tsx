import { useStore } from 'brust/store/react'
import { cart } from './shop'
import { fmt } from './fmt'

export default function ShopTotal({ unit }: { unit: string }) {
  const s = useStore(cart)
  const total = fmt(s.count, unit)
  return (
    <p>
      <b>{s.count}</b> {total}
    </p>
  )
}
