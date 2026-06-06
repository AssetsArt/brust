// A native, react-free counter. The co-located `behavior` holds the reactive
// state and handlers; the JSX binds to them with x-* directives. brust auto-injects
// x-data and ships the behavior as an on-demand chunk. This exact file is what the
// docs "Source" pane renders (inlined at build time) — no approximation.
import { signal } from 'brustjs/store'

export const behavior = () => {
  const count = signal(0)
  const inc = () => count.set(count() + 1)
  const dec = () => count.set(count() - 1)
  const reset = () => count.set(0)
  return { count, inc, dec, reset }
}

export default function Counter() {
  return (
    <div className="b-counter">
      <button type="button" x-on-click="dec" aria-label="decrement" className="b-counter__btn">
        −
      </button>
      <span x-text="count" className="b-counter__val">
        0
      </span>
      <button
        type="button"
        x-on-click="inc"
        aria-label="increment"
        className="b-counter__btn b-counter__btn--primary"
      >
        +
      </button>
      <button type="button" x-on-click="reset" className="b-counter__reset">
        Reset
      </button>
    </div>
  )
}
