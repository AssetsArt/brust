import { useState } from 'react'
import { Card } from './ui'

export default function Page() {
  const [n, set] = useState(0)
  return (
    <main>
      <button type="button" onClick={() => set(n + 1)}>
        more
      </button>
      <Card title="a">{n}</Card>
    </main>
  )
}
