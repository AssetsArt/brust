import { useState } from 'react'
import Counter from './Counter'

export default function Parent() {
  const [count, setCount] = useState(0)
  return (
    <section>
      <Counter n={count} onReset={() => setCount(0)} />
      <button type="button" onClick={() => setCount(count + 1)}>
        +1
      </button>
    </section>
  )
}
