import { useState } from 'react'

// F277: a native child with state of its own; `first` (`useState` with no setter) keeps the first `value` it saw.
export default function First({ value }: { value: number }) {
  const [first] = useState(value)
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="first" onClick={() => setN(n + 1)}>
      {first}:{n}
    </button>
  )
}
