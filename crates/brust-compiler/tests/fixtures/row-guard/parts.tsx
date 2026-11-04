export type Section = { id: string; type: string; items?: { on: boolean }[]; data: { title?: string; price?: number } }
export function Hero({ title }: { title?: string }) {
  return <h2 className="hero">{title}</h2>
}
// Throws for a row without a price (React never renders it there).
export function Price({ price }: { price: number }) {
  return <span className="price">{price.toFixed(2)}</span>
}
export function IfChain({ s }: { s: Section }) {
  if (s.type === 'hero') return <Hero title={s.data.title} />
  if (s.type === 'price') return <Price price={s.data.price!} />
  return null
}
export function SwitchChain({ s }: { s: Section }) {
  switch (s.type) {
    case 'hero':
      return <Hero title={s.data.title} />
    case 'price':
      return <Price price={s.data.price!} />
    default:
      return null
  }
}
export function AndRow({ s }: { s: Section }) {
  return <div>{s.type === 'price' && <Price price={s.data.price!} />}</div>
}
export function Ternary({ s }: { s: Section }) {
  return <div>{s.type !== 'price' ? <Hero title={s.data.title} /> : <Price price={s.data.price!} />}</div>
}
// A guard the server cannot evaluate per row (a comparison outside the guard subset).
export function Gt({ s }: { s: Section }) {
  return <div>{(s.data.price ?? 0) > 0 && <Price price={s.data.price!} />}</div>
}
