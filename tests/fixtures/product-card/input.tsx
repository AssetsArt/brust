import { useState } from 'react'
import { formatPrice } from './money'

export default function ProductCard({ item }: { item: { name: string; price: number } }) {
  const [qty, setQty] = useState(1)
  const unit = formatPrice(item.price)
  const total = formatPrice(item.price * qty)

  return (
    <article className="card">
      <h2>{item.name}</h2>
      <p className="unit">{unit}</p>
      <button type="button" onClick={() => setQty(qty + 1)}>
        Add one
      </button>
      <p className="total">Total: {total}</p>
    </article>
  )
}
