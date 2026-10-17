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

// F364 negative: a spread AFTER the ref may carry its own ref, so the ref is kept (and refused)
export default function Page(props: { label: string }) {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Row ref={ref} {...props} />
    </main>
  )
}
