// A NATIVE wrapper whose fed child is created by the client later (under a condition on state): no record could feed it.
import { useState } from 'react'
import Cell from '../per-instance-jobs/Cell'
export default function NativeWrapCond() {
  const [n, setN] = useState(0)
  return <div><button onClick={() => setN(n + 1)}>{n}</button>{n > 0 && <Cell tone="x">w</Cell>}</div>
}
