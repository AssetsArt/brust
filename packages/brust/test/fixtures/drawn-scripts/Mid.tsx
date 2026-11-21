import { useState } from 'react'
import Leaf from './Leaf'

export default function Mid() {
  const [n, setN] = useState(0)
  return (
    <div>
      <button type="button" id="mid" onClick={() => setN(n + 1)}>
        mid {n}
      </button>
      <Leaf />
    </div>
  )
}
