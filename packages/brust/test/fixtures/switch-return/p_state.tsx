import { useState } from 'react'

export default function Page() {
  const [kind, setKind] = useState('a')
  switch (kind) {
    case 'a':
      return <main><button data-testid="go" onClick={() => setKind('b')}>a</button></main>
    case 'b':
      return <main><button data-testid="go" onClick={() => setKind('c')}>b</button></main>
    default:
      return <main><button data-testid="go" onClick={() => setKind('a')}>c</button></main>
  }
}
