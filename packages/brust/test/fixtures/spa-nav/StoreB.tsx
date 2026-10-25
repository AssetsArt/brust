import { useStore } from '@brust/core/store/react'
import { cart } from './stores/cart'
import { late } from './stores/late'

/** Native: cart keeps a live tab's value (§5.5); late is first used here and seeds from this page's snapshot. */
export default function StoreB() {
  const c = useStore(cart)
  const l = useStore(late)
  return (
    <article data-page="store-b">
      <span id="cart">{c.count}</span> <span id="late">{l.v}</span>
    </article>
  )
}
