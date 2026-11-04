import { useState } from 'react'

export default function Page() {
  const [kind, setKind] = useState('a')
  switch (kind) {
    case 'a':
      return <button onClick={() => setKind('b')}>a</button>
    case 'b':
      return <button onClick={() => setKind('c')}>b</button>
    default:
      return <button onClick={() => setKind('a')}>c</button>
  }
}
