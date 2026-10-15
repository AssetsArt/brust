import { formatPrice } from './lib/fmt'
import { makeScope } from 'some-scope'

const NAME = 'Panel'
// A primitive const handed to a package call, and a component's devtools name: neither changes a printed value.
export const scope = makeScope(NAME, [])

const LABELS: Record<string, string> = { a: 'A', b: 'B' }
const xs = ['a', 'b']
const fmt = (n: number) => formatPrice(n)
function get() {
  return xs.join(',')
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
Wrap.displayName = 'Wrap'
export const Boxed = Object.freeze({ wrap: Wrap })

export default function Page({ price }: { price: number }) {
  return (
    <section>
      {get()}
      {LABELS.a}
      {fmt(price)}
    </section>
  )
}
