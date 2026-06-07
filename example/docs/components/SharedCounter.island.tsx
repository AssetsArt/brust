// REACT ISLAND — the other half of the "one store, two runtimes" demo. Subscribes
// to the SHARED demoStore with useStore (re-renders on change) and writes through
// the same store signal. Clicking here updates the react-free native component next
// to it — same window singleton, no bridge.
import { useStore } from 'brustjs/client'
import { demoStore } from '../stores/shared'

export default function SharedCounter() {
  const { count } = useStore(demoStore)
  return (
    <div className="b-shared">
      <button
        type="button"
        onClick={() => demoStore.count.set(demoStore.count() - 1)}
        aria-label="decrement"
        className="b-counter__btn"
      >
        −
      </button>
      <span className="b-counter__val">{count}</span>
      <button
        type="button"
        onClick={() => demoStore.count.set(demoStore.count() + 1)}
        aria-label="increment"
        className="b-counter__btn b-counter__btn--primary"
      >
        +
      </button>
    </div>
  )
}
