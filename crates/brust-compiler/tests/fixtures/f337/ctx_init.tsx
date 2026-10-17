import { createContext, useContext, useState } from 'react'
import { Simple } from './Child'
// F337 (Mellow A5, review round 1): a state initialised from a context is no seed: instance-prop-path stays.
const Start = createContext(13)
export default function Page() {
  const start = useContext(Start)
  const [v, setV] = useState(start)
  return (
    <main>
      <Simple v={v} />
      <button type="button" onClick={() => setV(v + 10)}>go</button>
    </main>
  )
}
