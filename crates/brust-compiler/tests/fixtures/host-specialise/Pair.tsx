import { useState } from 'react'
// prints its children next to an element of its own: a bare text slot there needs a wrapper
export default function Pair({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-n={n} onClick={() => setN(n + 1)}>
      <i>n</i>
      {children}
    </div>
  )
}
