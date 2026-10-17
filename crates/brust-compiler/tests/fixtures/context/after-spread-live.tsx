import { useState } from 'react'

// F329 W1 negative: a LIVE value written after the spread lands on the child's element through the child's own spread
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
      <Child {...extra} label="a" data-last={last} />
      <button type="button" onClick={() => setLast(last + 1)}>
        +
      </button>
    </main>
  )
}
