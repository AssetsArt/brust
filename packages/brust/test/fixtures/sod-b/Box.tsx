import { useState } from 'react'
// A native child with a host of its own (its own state) that prints its children inside that host.
export default function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      {children}
    </div>
  )
}
