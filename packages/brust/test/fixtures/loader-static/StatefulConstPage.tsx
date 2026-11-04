import { useState } from 'react'
import { Amount, type Row } from './parts'

// Review 05ee17fd (b): ConstPage on a page with state. Its props are the loader's, fixed for the page's life, so the
// branch still guards the throwing instance's job.
export default function StatefulConstPage({ rows }: { rows: Row[] }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button type="button" onClick={() => setN(n + 1)}>{n}</button>
      {rows.length === 0 && <Amount price={undefined as unknown as number} />}
      <p>{rows.length}</p>
    </main>
  )
}
