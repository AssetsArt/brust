import { useState } from 'react'
export default function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-n={n} onClick={() => setN(n + 1)}>
      {children}
    </div>
  )
}
