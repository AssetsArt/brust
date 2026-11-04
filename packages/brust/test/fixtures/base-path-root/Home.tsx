import { useState } from 'react'

export default function Home() {
  const [n, setN] = useState(0)
  return (
    <main data-app="root">
      <h1>root home</h1>
      <a id="to-portal" href="/portal">portal</a>
      <a id="to-about" href="/about">about</a>
      <button type="button" onClick={() => setN(n + 1)}>
        root count {n}
      </button>
    </main>
  )
}
