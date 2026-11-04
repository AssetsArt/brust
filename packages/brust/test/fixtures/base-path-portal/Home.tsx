import { useState } from 'react'

export default function Home() {
  const [n, setN] = useState(0)
  return (
    <main data-app="portal">
      <h1>portal home</h1>
      <a id="to-root" href="/">root</a>
      <a id="to-about" href="/portal/about">about</a>
      <button type="button" onClick={() => setN(n + 1)}>
        portal count {n}
      </button>
    </main>
  )
}
