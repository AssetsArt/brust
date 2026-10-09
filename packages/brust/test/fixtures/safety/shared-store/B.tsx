import { useState } from 'react'
import { bump } from './store'

export default function B() {
  const [c, setC] = useState(0)
  return <button onClick={() => setC(bump())}>B {c}</button>
}
