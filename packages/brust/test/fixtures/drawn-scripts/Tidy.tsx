import { useState } from 'react'
import { bump } from './lib/tidy'

export default function Tidy() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="tidy" onClick={() => setN(bump())}>
      tidy {n}
    </button>
  )
}
