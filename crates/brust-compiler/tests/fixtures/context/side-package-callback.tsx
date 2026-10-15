import { formatPrice } from './lib/fmt'
import { wrap } from 'some-wrap'
const xs = ['a', 'b']
// A package handed a callback that writes through its own parameter and calls app code: the package is trusted
// (ledger N1), as forwardRef / memo are; nothing runs that changes a module binding.
export const W = wrap((e: { value: string }) => {
  e.value = formatPrice(1)
})
function get() {
  return xs.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
