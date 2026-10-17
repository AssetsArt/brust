import { useState } from 'react'

// F329 W1 negative: written after the spread, but the child does not name it and spreads its rest onto an element
function Child({ label, ...rest }: any) {
  const [n, setN] = useState(0)
  return (
    <button {...rest} onClick={() => setN(n + 1)}>
      {label}
      {n}
    </button>
  )
}

export default function Page({ ...extra }: any) {
  const [last, setLast] = useState(-1)
  return (
    <main>
      <Child {...extra} label="a" onPick={(n: number) => setLast(n)} />
      <p>{last}</p>
    </main>
  )
}
