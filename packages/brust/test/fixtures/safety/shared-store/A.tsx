import { useState } from 'react'
import { bump } from './store'

export default function A() {
  const [c, setC] = useState(0)
  return <button onClick={() => setC(bump())}>A {c}</button>
}
