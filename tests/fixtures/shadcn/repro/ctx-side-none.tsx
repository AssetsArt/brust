import { formatPrice } from './ctxlib/fmt'

const LABELS: Record<string, string> = { a: 'A', b: 'B' }
const xs = ['a', 'b']
const fmt = (n: number) => formatPrice(n)
function get() {
  return xs.join(',')
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export const Boxed = Object.freeze({ wrap: Wrap })

export default function Page({ price = 5 }: { price?: number }) {
  return (
    <section>
      {get()}
      {LABELS.a}
      {fmt(price)}
    </section>
  )
}
