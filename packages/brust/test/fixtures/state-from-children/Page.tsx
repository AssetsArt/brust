// F404: the page holds the filed component with markup children, and a native counter beside it.
import { useState } from 'react'
import Seeded from './Seeded'

export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <Seeded>
        hello <b>world</b>
      </Seeded>
      <button id="count" onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
