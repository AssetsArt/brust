import { useReducer, useTransition } from 'react'

// A React island (useTransition).
export default function Counter() {
  useTransition()
  const [n, add] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-testid="count" onClick={add}>
      count {n}
    </button>
  )
}
