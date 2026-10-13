// useReducer ⇒ react tier: a React island that must hydrate from the static files.
import { useReducer } from 'react'

export default function Counter(props: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button className="counter" onClick={bump}>
      {props.label} {n}
    </button>
  )
}
