import { useState } from 'react'
// F320 (audit): a condition over a changing prop inside the rows of a constant list, in a child with an instance.
export default function Mid6({ on }: { on: boolean }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      {[1, 2].map((i) => (on ? <b key={i}>{i}</b> : <u key={i}>{-i}</u>))}
    </div>
  )
}
