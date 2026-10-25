// A native counter: its value survives a navigation only when its layout is kept.
import { useState } from 'react'

export default function Count(props: { name: string }) {
  const [n, setN] = useState(0)
  return (
    <button type="button" data-count={props.name} onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
