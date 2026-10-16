// F219: the same read from a native component (state of its own).
import { useState } from 'react'
import { LABELS, list } from './labels'
export default function LabelState() {
  const [n, setN] = useState(0)
  return (
    <p data-testid="q" onClick={() => setN(n + 1)}>
      {LABELS.a} {list.join(',')} {n}
    </p>
  )
}
