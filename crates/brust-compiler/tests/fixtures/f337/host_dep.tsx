import { useState } from 'react'
import { HostDep } from './Child'
// F337 (A2): the helper calls toLocaleString (host-dependent): the child cannot recompute it, the refusal stays.
export default function Page() {
  const [v, setV] = useState(13)
  return (
    <main>
      <HostDep v={v} />
      <button type="button" onClick={() => setV(v + 10)}>go</button>
    </main>
  )
}
