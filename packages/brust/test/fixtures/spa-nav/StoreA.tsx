import { useStore } from '@brust/core/store/react'
import { cart } from './stores/cart'

/** Native: the loader seeds cart.count = 5; a click writes the live store. */
export default function StoreA() {
  const c = useStore(cart)
  return (
    <article data-page="store-a">
      <button type="button" id="cart" onClick={() => cart.count.set(c.count + 1)}>
        {c.count}
      </button>
    </article>
  )
}
