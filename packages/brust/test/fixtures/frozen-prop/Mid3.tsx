import { useState } from 'react'
// The control: a native child reading the changing prop directly, which it follows (x-text).
export default function Mid3({ on }: { on: boolean }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      <b>{on ? 'a' : 'b'}</b>
    </div>
  )
}
