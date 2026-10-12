import { useState } from 'react'
import Entries from './Entries'

// F96d: a static child lists a prop that the parent's state feeds. The child is linked
// (x-props-bind) but its own list was printed without x-for, so it never repainted.
export default function F96LinkedListChild() {
  const [log, setLog] = useState<string[]>(['a'])
  return (
    <div>
      <button onClick={() => setLog(log.concat(['b']))}>add</button>
      <Entries log={log} />
    </div>
  )
}
