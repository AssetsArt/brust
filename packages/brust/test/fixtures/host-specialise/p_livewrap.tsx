import { useState } from 'react'
import { LiveWrap } from './LiveWrap'
// F348: the wrapper follows the page's changing `value`; the Provider clone inside it follows too.
export default function Page() {
  const [v, setV] = useState(0)
  return (
    <main>
      <button data-testid="f" onClick={() => setV(v + 1)}>f</button>
      <LiveWrap value={v} />
    </main>
  )
}
