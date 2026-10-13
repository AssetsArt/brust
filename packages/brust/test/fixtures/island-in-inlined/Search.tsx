import { useReducer } from 'react'

// useReducer keeps this a React island (hook-unsupported); the count proves it hydrated.
export default function Search({ label }: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-testid="search" onClick={() => bump()}>
      {label} {n}
    </button>
  )
}
