import { useState } from 'react'
import Frame from './wrapper'

export default function Page() {
  const [n, set] = useState(0)
  return (
    <main>
      <button type="button" onClick={() => set(n + 1)}>
        more
      </button>
      <Frame title="a">{n}</Frame>
    </main>
  )
}
