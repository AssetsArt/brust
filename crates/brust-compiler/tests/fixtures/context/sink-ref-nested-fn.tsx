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

// F364 negative: the ref is used inside a nested function
export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  const get = () => ref
  return (
    <main>
      <Row label="a" ref={ref} />
      <button type="button" onClick={() => get()}>x</button>
    </main>
  )
}
