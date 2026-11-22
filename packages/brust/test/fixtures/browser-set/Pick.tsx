import { useState } from 'react'
import { NAMES } from './lib/names'

// F610 D1: a native component whose chunk bundles `lib/names.ts`, which reads the table `PAGES` at load.
export default function Pick() {
  const [i, setI] = useState(0)
  return (
    <button type="button" id="pick" onClick={() => setI((i + 1) % NAMES.length)}>
      {NAMES[i]}
    </button>
  )
}
