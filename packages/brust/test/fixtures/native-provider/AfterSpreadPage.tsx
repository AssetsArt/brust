import { useState } from 'react'

// F329 part a (W1): a function prop written after a spread of unknown keys is called by the child, and the page's own handler runs
function Child({ onPick, label, ...rest }: any) {
  const [n, setN] = useState(0)
  return (
    <button {...rest} onClick={() => { setN(n + 1); onPick(n) }}>
      {`${label}${n}`}
    </button>
  )
}

function Wrap({ ...extra }: any) {
  const [last, setLast] = useState(-1)
  return (
    <>
      <Child {...extra} label="a" onPick={(n: number) => setLast(n)} />
      <p>{last}</p>
    </>
  )
}

export default function AfterSpreadPage() {
  return (
    <main>
      <Wrap data-x="1" />
    </main>
  )
}
