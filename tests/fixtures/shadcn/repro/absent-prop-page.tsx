// F234 repro: a native child's prop the call site omits (or passes as `undefined`) takes its destructuring default, as in
// React; an explicit `null` stays null. <Ch /> paints aria-expanded="false" and keeps it after hydration.
import { useState } from 'react'
import Ch from './absent-prop/Ch'
import Show from './absent-prop/Show'
import Who from './absent-prop/Who'

export default function Page() {
  const [on, setOn] = useState(true)
  return (
    <main>
      <Ch id="omitted" />
      <Ch id="undef" defaultOpen={undefined} />
      <Ch id="null" defaultOpen={null} />
      <Ch id="true" defaultOpen={true} />
      <button data-testid="flip" onClick={() => setOn(!on)}>
        flip
      </button>
      <Who />
      <Show v={on ? 'set' : undefined} user={on ? { name: 'ann' } : undefined} />
    </main>
  )
}
