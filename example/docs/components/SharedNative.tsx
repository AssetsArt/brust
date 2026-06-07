// NATIVE INTERACTIVE COMPONENT (react-free) — half of the "one store, two runtimes"
// demo. Its behavior binds x-* directives to the SHARED demoStore signal; clicking
// here updates the React island next to it, because both resolve to the same store
// singleton. Ships as its own directive chunk; zero React.
import { demoStore } from '../stores/shared'

export const behavior = () => {
  const { count } = demoStore
  return {
    count,
    inc: () => count.set(count() + 1),
    dec: () => count.set(count() - 1),
  }
}

export default function SharedNative() {
  return (
    <div className="b-shared">
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
    </div>
  )
}
