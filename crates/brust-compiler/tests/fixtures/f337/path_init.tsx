import { useState } from 'react'
import { Simple } from './Child'
// F337 (M2): a state seeded from a props path: the record binds that path.
export default function Page({ start }: { start: number }) {
  const [v, setV] = useState(start)
  return (
    <main>
      <Simple v={v} />
      <button type="button" onClick={() => setV(v + 10)}>go</button>
    </main>
  )
}
