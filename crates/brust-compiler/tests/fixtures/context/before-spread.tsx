import { useState } from 'react'

// F329 W1 negative: written BEFORE the spread, so it may be replaced by it (refused). A function prop written AFTER a spread of unknown keys wins in React; the child names it, so it never reaches an
// element through the child's own spread
function Child({ onPick, label, ...rest }: any) {
  const [n, setN] = useState(0)
  return (
    <button {...rest} onClick={() => { setN(n + 1); onPick(n) }}>
      {label}
      {n}
    </button>
  )
}

export default function Page({ ...extra }: any) {
  const [last, setLast] = useState(-1)
  return (
    <main>
      <Child onPick={(n: number) => setLast(n)} {...extra} label="a" />
      <p>{last}</p>
    </main>
  )
}
