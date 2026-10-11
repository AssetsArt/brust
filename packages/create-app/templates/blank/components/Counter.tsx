// useState only, so the compiler lowers this to a native component: a signal in the browser, no React shipped.
import { useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      count is {count}
    </button>
  )
}
