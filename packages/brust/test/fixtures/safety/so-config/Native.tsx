import { useState } from 'react'
import { DB_URL } from './lib/server/db'

export default function Native() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + DB_URL.length)}>n={n}</button>
}
