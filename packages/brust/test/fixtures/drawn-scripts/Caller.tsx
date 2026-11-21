import { useState } from 'react'
import { FIRST } from './lib/caller'

export default function Caller() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="caller" onClick={() => setN(n + FIRST)}>
      caller {n}
    </button>
  )
}
