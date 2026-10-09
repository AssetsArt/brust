// Native tier; the handler (client code) uses SECRET, whose module imports node:fs.
import { useState } from 'react'
import { SECRET } from './secrets'

export default function Leak() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + SECRET.length)}>n={n}</button>
}
