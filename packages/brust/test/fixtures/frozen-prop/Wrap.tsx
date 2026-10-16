import { useState } from 'react'
import Mid5 from './Mid5'
// Mellow F1, pass-up: a native wrapper (it links Mid5 with its own state) passes its own prop into Mid5's rest.
export default function Wrap({ on }: { on: boolean }) {
  const [j, setJ] = useState(0)
  return (
    <section data-j={j} onDoubleClick={() => setJ(j + 1)}>
      <Mid5 x={j} on={on} />
    </section>
  )
}
