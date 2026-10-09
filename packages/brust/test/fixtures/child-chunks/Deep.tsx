// A grandchild with its own handler (chunk-bearing), two levels below the chain component.
import { useState } from 'react'

export default function Deep() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>{n}</button>
}
