import { useState } from 'react'
import { hits } from './store'

export default function Native() {
  const [n, setN] = useState(0)
  return <button onClick={() => { setN(n + 1); hits.set(hits() + 1) }}>native {n}</button>
}
