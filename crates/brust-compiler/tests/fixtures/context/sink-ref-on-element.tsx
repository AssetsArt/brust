import * as React from 'react'
import { useState } from 'react'

const Row = React.forwardRef<HTMLButtonElement, { label: string }>(function Row({ label }, forwardedRef) {
  const [n, setN] = useState(0)
  return (
    <button ref={forwardedRef} type="button" onClick={() => setN(n + 1)}>
      {`${label}${n}`}
    </button>
  )
})

// F364 negative: the ref is also bound to a host element, so it is not a sink
export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Row label="a" ref={ref} />
      <p ref={ref as any}>x</p>
    </main>
  )
}
