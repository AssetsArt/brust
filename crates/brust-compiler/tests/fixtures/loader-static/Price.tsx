const formatPrice = (n: number) => `฿${n.toFixed(2)}`
export function Price({ price }: { price: string }) {
  return <span className="price">{formatPrice(Number(price))}</span>
}
