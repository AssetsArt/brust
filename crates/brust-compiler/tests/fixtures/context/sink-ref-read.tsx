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

// F329 negative: the ref is read in a handler, so the call site keeps its fallback
export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Row label="a" ref={ref} />
      <button type="button" onClick={() => ref.current?.focus()}>
        focus
      </button>
    </main>
  )
}
