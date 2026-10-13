import { buildTime } from '@brust/core'
import { useState } from 'react'

export default function Client() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(buildTime(() => n + 1))}>{n}</button>
}
