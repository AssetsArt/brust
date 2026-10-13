import { useState } from 'react'

const NOT_A_NUMBER = 0 / 0
const HUGE = 1 / 0

export default function Page() {
  const [n, setN] = useState(NOT_A_NUMBER)
  const [h] = useState(HUGE)
  return (
    <div>
      <button onClick={() => setN(1)}>{n}</button>
      <span>{h}</span>
    </div>
  )
}
