import { useState } from 'react'

// A native page: a counter makes it interactive without React on the client.
export default function Home() {
  const [n, setN] = useState(0)
  return (
    <main data-page="home">
      <h1>home</h1>
      <button type="button" onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
