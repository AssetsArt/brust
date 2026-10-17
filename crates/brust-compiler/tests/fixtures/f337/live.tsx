import { useState } from 'react'
import { Simple } from './Child'
// F337: a state passed to a child whose values derive from it through plain helpers: native, the child follows.
export default function Page() {
  const [v, setV] = useState(13)
  return (
    <main>
      <Simple v={v} />
      <button type="button" onClick={() => setV(v + 10)}>go</button>
    </main>
  )
}
