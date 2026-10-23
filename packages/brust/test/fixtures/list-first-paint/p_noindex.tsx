import { useState } from 'react'

// B-10 without the index: the shown row is picked by its own name.
const ROWS = [{ name: 'read' }, { name: 'write' }, { name: 'openat' }]
export default function PNoindex() {
  const [pick, setPick] = useState('openat')
  return (
    <main>
      <button type="button" data-testid="first" onClick={() => setPick('read')}>
        first
      </button>
      {ROWS.map((r) => (
        <p key={r.name} hidden={pick !== r.name}>
          {r.name}
        </p>
      ))}
    </main>
  )
}
