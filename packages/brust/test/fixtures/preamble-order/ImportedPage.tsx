import { useState } from 'react'
import { fmt } from './fmt'
import { useLabel, useOuter } from './hooks'

// A hook of this module that calls an import: its value is a per-request job reading the argument's binding.
function useFmt(n: number) {
  return fmt(n)
}

export default function ImportedPage() {
  const [k, setK] = useState(3)
  const a = useLabel(7)
  const b = useOuter(2)
  const c = useFmt(k)
  return (
    <main>
      <p data-testid="imported" title={a} data-outer={b}>
        imported
      </p>
      <button type="button" data-testid="fmt" onClick={() => setK(k + 1)}>
        {c}
      </button>
    </main>
  )
}
