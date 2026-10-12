import { formatPrice } from '../lib/money'

export default function Item({ item }: { item: { id: string; price: number } }) {
  return (
    <article>
      <h1>item {item.id}</h1>
      <p className="price">{formatPrice(item.price)}</p>
    </article>
  )
}
