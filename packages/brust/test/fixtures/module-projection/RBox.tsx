import { useState } from 'react'
// F362: Box with an id, so a page can click the host of one row.
export default function RBox({ id, children }: { id: string; children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid={id} data-n={n} style={{ padding: 4 }} onClick={() => setN(n + 1)}>
      {children}
    </div>
  )
}
