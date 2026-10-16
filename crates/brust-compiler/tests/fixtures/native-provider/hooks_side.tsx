import { useState } from 'react'
import { useId } from './rid_side'

export default function Panel() {
  const id = useId()
  const [n, setN] = useState(0)
  return (
    <button id={id} onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
