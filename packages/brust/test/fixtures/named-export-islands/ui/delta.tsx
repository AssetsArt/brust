import { useReducer, useTransition } from 'react'

export function Delta({ label }: { label: string }) {
  useTransition()
  const [n, hit] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-testid="delta" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}

export default function Epsilon({ label }: { label: string }) {
  useTransition()
  const [n, hit] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-testid="epsilon" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}
