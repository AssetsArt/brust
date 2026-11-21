import { useState } from 'react'
import { STEP } from './lib/busy'

export default function Busy() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="busy" onClick={() => setN(n + STEP)}>
      busy {n}
    </button>
  )
}
