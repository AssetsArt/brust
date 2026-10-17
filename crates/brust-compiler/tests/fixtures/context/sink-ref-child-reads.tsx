import * as React from 'react'
import { useState } from 'react'

// F364 negative: the child READS its forwarded ref (an effect), so it is React and the sink drop must not apply
const Row = React.forwardRef<HTMLButtonElement, { label: string }>(function Row({ label }, forwardedRef) {
  const [n, setN] = useState(0)
  React.useEffect(() => {
    forwardedRef && typeof forwardedRef !== 'function' && forwardedRef.current?.focus()
  }, [forwardedRef])
  return (
    <button ref={forwardedRef} type="button" onClick={() => setN(n + 1)}>
      {`${label}${n}`}
    </button>
  )
})

export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Row label="a" ref={ref} />
    </main>
  )
}
