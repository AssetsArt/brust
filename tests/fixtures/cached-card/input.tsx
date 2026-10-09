import { cache } from 'brust'
import { formatPrice } from './money'

function ProductCard({ item }: { item: { id: string; name: string; price: number } }) {
  return (
    <article>
      <h2>{item.name}</h2>
      <p>{formatPrice(item.price)}</p>
    </article>
  )
}

export default cache(ProductCard, {
  key: (p) => p.item.id,
  tags: (p) => ['product', p.item.id],
  revalidate: 60,
})
