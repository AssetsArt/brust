// A NATIVE wrapper (state + handler, so it has a client chunk) around a child with a job of its own.
import { useState } from 'react'
import Cell from '../per-instance-jobs/Cell'
export default function NativeWrap() {
  const [n, setN] = useState(0)
  return <div><button onClick={() => setN(n + 1)}>{n}</button><Cell tone="x">w</Cell></div>
}
