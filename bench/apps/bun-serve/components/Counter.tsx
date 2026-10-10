import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter({ start = 0, label = 'clicks' }: { start?: number; label?: string }) {
  const [n, dispatch] = useReducer(reducer, start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{label}: {n}</button>
    </div>
  )
}
