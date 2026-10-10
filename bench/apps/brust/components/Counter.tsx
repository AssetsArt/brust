// React tier on purpose (useReducer): SSR via renderToString job + idle hydration (S12).
import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter(props: { start: number; label: string }) {
  const [n, dispatch] = useReducer(reducer, props.start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{props.label}: {n}</button>
    </div>
  )
}
