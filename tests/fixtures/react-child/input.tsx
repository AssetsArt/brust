import Reviews from './Reviews'

export default function ProductPage({ productId, title }: { productId: string; title: string }) {
  return (
    <main>
      <h1>{title}</h1>
      <Reviews productId={productId} />
    </main>
  )
}
