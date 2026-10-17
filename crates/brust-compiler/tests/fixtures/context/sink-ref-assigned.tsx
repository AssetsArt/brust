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

// F364 negative: the ref cell is written
export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  ref.current = null
  return (
    <main>
      <Row label="a" ref={ref} />
    </main>
  )
}
