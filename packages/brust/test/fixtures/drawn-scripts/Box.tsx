import { useState } from 'react'
import type { ReactNode } from 'react'

// Case 11: a native host that prints its children; two call sites with different children get their own copies.
export default function Box({ children }: { children?: ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div className="box" data-n={n} onClick={() => setN(n + 1)}>
      {children}
    </div>
  )
}
