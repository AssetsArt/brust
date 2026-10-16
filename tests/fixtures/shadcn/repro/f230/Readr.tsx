// F230 case r: a native component (state of its own) and a static read of module B.
import { useState } from 'react'
import { LABELS, list } from './labels-r'
export function Read() {
  const [n, setN] = useState(0)
  return (
    <p data-testid="q" onClick={() => setN(n + 1)}>
      {LABELS.a} {list.join(',')} {n}
    </p>
  )
}
export default function Pager() {
  return (
    <main>
      <p data-testid="p">
        {LABELS.a} {list.join(',')}
      </p>
      <Read />
    </main>
  )
}
