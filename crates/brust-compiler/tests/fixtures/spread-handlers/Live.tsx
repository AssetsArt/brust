// A native child (state of its own) that spreads its props: R34.19, not bound by the parent.
import { useState } from 'react'
export default function Live(props: any) {
  const [n, setN] = useState(0)
  return <span><button {...props} /><i onClick={() => setN(n + 1)}>{n}</i></span>
}
